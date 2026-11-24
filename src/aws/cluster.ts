/**
 * AWS EKS cluster implementation with Auto Mode support.
 *
 * @module aws/cluster
 */

import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { ICluster, IClusterConfig } from "../cluster";
import type { INetwork } from "../network";
import { resolveCloudTarget } from "../types";

/** AWS-specific EKS options beyond the base config. */
export interface IEksOptions {
  /** Enable EKS Auto Mode (managed node provisioning). Default: false. */
  readonly autoMode?: boolean;
  /** EKS add-ons to install. Default: vpc-cni, coredns, kube-proxy. */
  readonly addons?: ReadonlyArray<string>;
  /** Endpoint access: "public", "private", or "both". Default: "both". */
  readonly endpointAccess?: "public" | "private" | "both";
  /** CIDRs allowed to reach the public Kubernetes API endpoint. */
  readonly publicAccessCidrs?: ReadonlyArray<string>;
  /** IAM role ARN to grant cluster-admin through an EKS access entry. */
  readonly clusterAdminRoleArn?: pulumi.Input<string>;
  /** Root EBS settings for managed node groups. Omitted preserves EKS defaults. */
  readonly nodeGroupRootDisk?: {
    /** Root volume size in GiB. Defaults to 20 when this option is set. */
    readonly sizeGiB?: number;
    /** Delete the root volume when the node terminates. Defaults to true. */
    readonly deleteOnTermination?: boolean;
  };
  /** Install the EBS CSI add-on and its Pod Identity permissions. */
  readonly ebsCsiDriver?: boolean;
}

const DEFAULT_ADDONS = ["vpc-cni", "coredns", "kube-proxy"];

/**
 * Create an EKS cluster with optional Auto Mode.
 *
 * @example
 * ```typescript
 * const cluster = createEksCluster("prod", {
 *   cloud: "aws",
 *   nodePools: [
 *     { name: "system", instanceType: "t4g.small", minNodes: 2, maxNodes: 3 },
 *     { name: "spot", instanceType: "t4g.medium", minNodes: 1, maxNodes: 10, spot: true },
 *   ],
 * }, network, { autoMode: true });
 * ```
 */
export function createEksCluster(
  name: string,
  config: IClusterConfig,
  network: INetwork,
  options?: IEksOptions
): ICluster {
  const cloud = Array.isArray(config.cloud) ? (config.cloud[0] ?? "aws") : config.cloud;
  const target = resolveCloudTarget(cloud);

  const tags = config.tags ?? {};
  const autoMode = options?.autoMode ?? config.autoMode ?? false;
  const addons = options?.addons ?? DEFAULT_ADDONS;
  const endpointAccess = options?.endpointAccess ?? "both";
  const ebsCsiDriver = options?.ebsCsiDriver === true || addons.includes("aws-ebs-csi-driver");

  if (autoMode && options?.nodeGroupRootDisk) {
    throw new Error("nodeGroupRootDisk applies only to EKS managed node groups, not Auto Mode.");
  }
  if (autoMode && ebsCsiDriver) {
    throw new Error(
      "EKS Auto Mode provides block storage; do not enable the standard EBS CSI add-on."
    );
  }
  if (
    options?.nodeGroupRootDisk?.sizeGiB !== undefined &&
    (!Number.isInteger(options.nodeGroupRootDisk.sizeGiB) || options.nodeGroupRootDisk.sizeGiB <= 0)
  ) {
    throw new Error("nodeGroupRootDisk.sizeGiB must be a positive integer.");
  }

  // EKS cluster IAM role
  const clusterRole = new aws.iam.Role(`${name}-cluster-role`, {
    namePrefix: `${name}-eks`,
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { Service: "eks.amazonaws.com" },
        },
      ],
    }),
    tags,
  });

  new aws.iam.RolePolicyAttachment(`${name}-cluster-policy`, {
    policyArn: "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
    role: clusterRole.name,
  });

  // EKS Cluster
  const cluster = new aws.eks.Cluster(`${name}-cluster`, {
    name,
    roleArn: clusterRole.arn,
    version: config.version,
    vpcConfig: {
      subnetIds: pulumi
        .all([network.publicSubnetIds, network.privateSubnetIds])
        .apply(([pub, priv]) => [...pub, ...priv]),
      endpointPrivateAccess: endpointAccess === "private" || endpointAccess === "both",
      endpointPublicAccess: endpointAccess === "public" || endpointAccess === "both",
      publicAccessCidrs: options?.publicAccessCidrs ? [...options.publicAccessCidrs] : undefined,
    },
    computeConfig: autoMode ? { enabled: true } : undefined,
    accessConfig: { authenticationMode: "API_AND_CONFIG_MAP" },
    tags: { ...tags, [`kubernetes.io/cluster/${name}`]: "owned" },
  });

  // Node pools — Auto Mode delegates to EKS, standard uses managed node groups
  const nodeGroups: aws.eks.NodeGroup[] = [];

  if (!autoMode) {
    for (const np of config.nodePools) {
      const nodeRole = createNodeRole(`${name}-${np.name}`, tags);
      const launchTemplate = options?.nodeGroupRootDisk
        ? new aws.ec2.LaunchTemplate(`${name}-lt-${np.name}`, {
            blockDeviceMappings: [
              {
                deviceName: "/dev/xvda",
                ebs: {
                  volumeSize: options.nodeGroupRootDisk.sizeGiB ?? 20,
                  volumeType: "gp3",
                  encrypted: "true",
                  deleteOnTermination: String(
                    options.nodeGroupRootDisk.deleteOnTermination ?? true
                  ),
                },
              },
            ],
            tags: { ...tags, Name: `${name}-${np.name}-launch-template` },
          })
        : undefined;
      nodeGroups.push(
        new aws.eks.NodeGroup(`${name}-ng-${np.name}`, {
          clusterName: cluster.name,
          nodeGroupName: `${name}-${np.name}`,
          nodeRoleArn: nodeRole.arn,
          instanceTypes: [np.instanceType],
          capacityType: np.spot ? "SPOT" : "ON_DEMAND",
          scalingConfig: {
            desiredSize: np.desiredNodes ?? np.minNodes,
            minSize: np.minNodes,
            maxSize: np.maxNodes,
          },
          subnetIds: network.privateSubnetIds as pulumi.Output<string[]>,
          labels: np.labels,
          launchTemplate: launchTemplate
            ? {
                id: launchTemplate.id,
                version: launchTemplate.latestVersion.apply((version) => String(version)),
              }
            : undefined,
          tags: { ...tags, Name: `${name}-${np.name}` },
        })
      );
    }
  }

  const firstNodeGroup = nodeGroups[0];

  // Grant the EBS CSI controller its AWS permissions through EKS Pod Identity.
  let ebsCsiRole: aws.iam.Role | undefined;
  if (ebsCsiDriver) {
    ebsCsiRole = new aws.iam.Role(`${name}-ebs-csi-role`, {
      namePrefix: `${name}-ebs-csi-`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "pods.eks.amazonaws.com" },
            Action: ["sts:AssumeRole", "sts:TagSession"],
          },
        ],
      }),
      tags,
    });
    new aws.iam.RolePolicyAttachment(`${name}-ebs-csi-policy`, {
      policyArn: "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicyV2",
      role: ebsCsiRole.name,
    });
  }

  // Add-on names are deduplicated so the explicit add-on list can include the
  // EBS driver without creating a second copy of it or its Pod Identity agent.
  const addonNames = new Set(addons);
  if (ebsCsiDriver) {
    addonNames.add("eks-pod-identity-agent");
    // Ensure callers that explicitly listed the CSI add-on still get its
    // required Pod Identity agent created first.
    addonNames.delete("aws-ebs-csi-driver");
    addonNames.add("aws-ebs-csi-driver");
  }

  // EKS Add-ons
  let podIdentityAgent: aws.eks.Addon | undefined;
  for (const addon of addonNames) {
    const dependsOn: pulumi.Resource[] = firstNodeGroup ? [firstNodeGroup] : [];
    if (addon === "aws-ebs-csi-driver" && podIdentityAgent) {
      dependsOn.push(podIdentityAgent);
    }
    const addonResource = new aws.eks.Addon(
      `${name}-addon-${addon}`,
      {
        clusterName: cluster.name,
        addonName: addon,
        resolveConflictsOnCreate: "OVERWRITE",
        resolveConflictsOnUpdate: "OVERWRITE",
        podIdentityAssociations:
          addon === "aws-ebs-csi-driver" && ebsCsiRole
            ? [{ roleArn: ebsCsiRole.arn, serviceAccount: "ebs-csi-controller-sa" }]
            : undefined,
        tags,
      },
      dependsOn.length ? { dependsOn } : undefined
    );
    if (addon === "eks-pod-identity-agent") podIdentityAgent = addonResource;
  }

  if (options?.clusterAdminRoleArn) {
    const accessEntry = new aws.eks.AccessEntry(`${name}-cluster-admin-entry`, {
      clusterName: cluster.name,
      principalArn: options.clusterAdminRoleArn,
      type: "STANDARD",
      tags,
    });
    new aws.eks.AccessPolicyAssociation(
      `${name}-cluster-admin-policy`,
      {
        clusterName: cluster.name,
        principalArn: options.clusterAdminRoleArn,
        policyArn: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy",
        accessScope: { type: "cluster" },
      },
      { dependsOn: [accessEntry] }
    );
  }

  // K8s provider for this cluster
  const kubeconfig = pulumi
    .all([cluster.endpoint, cluster.certificateAuthority, cluster.name])
    .apply(([endpoint, ca, clusterName]) =>
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          {
            cluster: {
              server: endpoint,
              "certificate-authority-data": ca.data,
            },
            name: clusterName,
          },
        ],
        contexts: [
          {
            context: { cluster: clusterName, user: clusterName },
            name: clusterName,
          },
        ],
        "current-context": clusterName,
        users: [
          {
            name: clusterName,
            user: {
              exec: {
                apiVersion: "client.authentication.k8s.io/v1beta1",
                command: "aws",
                args: ["eks", "get-token", "--cluster-name", clusterName],
              },
            },
          },
        ],
      })
    );

  const provider = new k8s.Provider(`${name}-k8s`, {
    kubeconfig,
  });

  return {
    name,
    cloud: target,
    endpoint: cluster.endpoint,
    kubeconfig,
    version: cluster.version,
    nodePools: config.nodePools,
    nativeResource: cluster,
    provider,
  };
}

function createNodeRole(name: string, tags: Readonly<Record<string, string>>): aws.iam.Role {
  const role = new aws.iam.Role(`${name}-node-role`, {
    namePrefix: `${name}-node`,
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Action: "sts:AssumeRole",
          Effect: "Allow",
          Principal: { Service: "ec2.amazonaws.com" },
        },
      ],
    }),
    tags,
  });

  const policies = [
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ];

  for (const policyArn of policies) {
    const shortName = policyArn.split("/").pop() ?? policyArn;
    new aws.iam.RolePolicyAttachment(`${name}-${shortName}`, {
      policyArn,
      role: role.name,
    });
  }

  return role;
}
