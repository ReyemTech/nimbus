/**
 * AWS EKS cluster implementation with Auto Mode support.
 *
 * @module aws/cluster
 */

import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IClusterConfig, IManagedNodePool, IClusterWithFluentOperations } from "../cluster";
import { withClusterFluentOperations } from "../cluster/fluent";
import type { INetwork } from "../network";
import { resolveCloudTarget } from "../types";
import {
  createEksAutoscaling,
  isKarpenterPool,
  validateEksNodePoolScaling,
} from "./eks-autoscaling";
import { createAwsClusterTags } from "./tagging";
import type { IPodDisruptionBudgetConfig, IPodSchedulingConfig } from "../availability";

/** EKS community Metrics Server add-on configuration. */
export interface IEksMetricsServerOptions {
  /** Create the add-on. Defaults to `true` when an options object is provided. */
  readonly enabled?: boolean;
  /** EKS add-on version. AWS validates compatibility with the cluster version. */
  readonly addonVersion?: pulumi.Input<string>;
  /** JSON add-on configuration values. */
  readonly configurationValues?: pulumi.Input<string>;
}

/** Version and configuration overrides for an EKS add-on. */
export interface IEksAddonOptions {
  readonly version?: pulumi.Input<string>;
  readonly configurationValues?: pulumi.Input<string>;
}

/** Add-on using a caller-managed EKS Pod Identity role. */
export interface IEksPodIdentityAddonOptions extends IEksAddonOptions {
  readonly podIdentityRoleArn: pulumi.Input<string>;
}

/** EFS CSI roles for the controller and, optionally, the S3 Files node plugin. */
export interface IEksEfsCsiAddonOptions extends IEksPodIdentityAddonOptions {
  /** Additional role for `efs-csi-node-sa` when using Amazon S3 Files. */
  readonly nodePodIdentityRoleArn?: pulumi.Input<string>;
}

/** Add-on using a caller-managed IRSA role. */
export interface IEksServiceAccountRoleAddonOptions extends IEksAddonOptions {
  readonly serviceAccountRoleArn: pulumi.Input<string>;
}

/** Version and configuration overrides for one AWS community add-on. */
export type IEksCommunityAddonOptions = IEksAddonOptions;

/** Community add-ons Nimbus coordinates with its platform and observability stacks. */
export interface IEksCommunityAddons {
  readonly prometheusNodeExporter?: IEksCommunityAddonOptions;
  readonly kubeStateMetrics?: IEksCommunityAddonOptions;
  readonly certManager?: IEksCommunityAddonOptions;
}

/** AWS-managed EKS add-ons beyond the default networking and DNS add-ons. */
export interface IEksAwsAddons {
  /** Amazon EFS CSI driver. Requires a role with EFS CSI controller permissions. */
  readonly efsCsiDriver?: IEksEfsCsiAddonOptions;
  /** AWS Secrets Store CSI provider; workload pods need their own IAM identity. */
  readonly secretsStoreCsiDriverProvider?: IEksAddonOptions;
  /** CloudWatch agent, Container Insights, and Application Signals. */
  readonly cloudWatchObservability?: IEksPodIdentityAddonOptions;
  /** CSI snapshot CRDs and controller; requires a compatible CSI driver. */
  readonly csiSnapshotController?: IEksAddonOptions;
  /** GuardDuty runtime agent; GuardDuty Runtime Monitoring must be enabled. */
  readonly guardDutyAgent?: IEksAddonOptions;
  /** Node health agent; EKS Auto Mode already includes this agent. */
  readonly nodeMonitoringAgent?: IEksAddonOptions;
  /** S3 Mountpoint CSI driver; requires a bucket-scoped IRSA role. */
  readonly mountpointS3CsiDriver?: IEksServiceAccountRoleAddonOptions;
  /** FSx for Lustre CSI driver. Requires an FSx CSI controller role. */
  readonly fsxCsiDriver?: IEksPodIdentityAddonOptions;
}

/** AWS-specific EKS options beyond the base config. */
export interface IEksOptions {
  /** Enable EKS Auto Mode (managed node provisioning). Default: false. */
  readonly autoMode?: boolean;
  /** EKS add-ons to install. Default: vpc-cni, coredns, kube-proxy. */
  readonly addons?: ReadonlyArray<string>;
  /** Typed opt-in EKS community add-ons; selected components replace Nimbus Helm copies. */
  readonly communityAddons?: IEksCommunityAddons;
  /** Typed opt-in AWS-managed EKS add-ons and their IAM role bindings. */
  readonly awsAddons?: IEksAwsAddons;
  /** Endpoint access: "public", "private", or "both". Default: "both". */
  readonly endpointAccess?: "public" | "private" | "both";
  /** CIDRs allowed to reach the public Kubernetes API endpoint. */
  readonly publicAccessCidrs?: ReadonlyArray<string>;
  /** IAM role or user principal ARN to grant cluster-admin through an EKS access entry. */
  readonly clusterAdminRoleArn?: pulumi.Input<string>;
  /** IAM role ARN for the Kubernetes provider's `aws eks get-token` exec authentication. */
  readonly kubernetesProviderRoleArn?: pulumi.Input<string>;
  /** Root EBS settings for managed node groups. Omitted preserves EKS defaults. */
  readonly nodeGroupRootDisk?: {
    /** Root volume size in GiB. Defaults to 20 when this option is set. */
    readonly sizeGiB?: number;
    /** Delete the root volume when the node terminates. Defaults to true. */
    readonly deleteOnTermination?: boolean;
  };
  /** Install the EBS CSI add-on and its Pod Identity permissions. */
  readonly ebsCsiDriver?: boolean;
  /** EKS API authentication mode. Defaults to API_AND_CONFIG_MAP. */
  readonly authenticationMode?: "API" | "API_AND_CONFIG_MAP" | "CONFIG_MAP";
  /** Whether the cluster creator receives bootstrap administrator access. */
  readonly bootstrapClusterCreatorAdminPermissions?: boolean;
  /** EKS version support policy. Omitted preserves the AWS default (EXTENDED). */
  readonly upgradePolicy?: { readonly supportType: "STANDARD" | "EXTENDED" };
  /** Tags applied to EC2 instances in managed node groups. */
  readonly nodeGroupInstanceTags?: Readonly<Record<string, string>>;
  /** Managed node-group AMI family, for example AL2023_ARM_64_STANDARD. */
  readonly nodeGroupAmiType?: pulumi.Input<string>;
  /** Opt in to the EKS community Metrics Server add-on. */
  readonly metricsServer?: boolean | IEksMetricsServerOptions;
  /** Shared Cluster Autoscaler Helm chart options; enabled by CA-managed pools. */
  readonly clusterAutoscaler?: {
    readonly version?: pulumi.Input<string>;
    /** Existing cluster OIDC provider ARN; Nimbus creates one when omitted. */
    readonly oidcProviderArn?: pulumi.Input<string>;
    readonly podDisruptionBudget?: IPodDisruptionBudgetConfig;
    readonly scheduling?: IPodSchedulingConfig;
  };
  /** Shared Karpenter Helm chart and interruption handling options. */
  readonly karpenter?: {
    readonly version?: pulumi.Input<string>;
    readonly namespace?: string;
    readonly interruptionHandling?: boolean;
    readonly podDisruptionBudget?: IPodDisruptionBudgetConfig;
    readonly scheduling?: IPodSchedulingConfig;
  };
  /** Stable on-demand managed pool that hosts autoscaler controller pods. */
  readonly autoscalerControllerNodePoolName?: string;
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
): IClusterWithFluentOperations {
  const cloud = Array.isArray(config.cloud) ? (config.cloud[0] ?? "aws") : config.cloud;
  const target = resolveCloudTarget(cloud);

  const tags = createAwsClusterTags(aws.config.region ?? target.region, name, config.tags);
  const autoMode = options?.autoMode ?? config.autoMode ?? false;
  const addons = options?.addons ?? DEFAULT_ADDONS;
  const endpointAccess = options?.endpointAccess ?? "both";
  const authenticationMode = options?.authenticationMode ?? "API_AND_CONFIG_MAP";
  const ebsCsiDriver = options?.ebsCsiDriver === true || addons.includes("aws-ebs-csi-driver");
  const communityAddonSettings: Readonly<Record<string, IEksCommunityAddonOptions | undefined>> = {
    "prometheus-node-exporter": options?.communityAddons?.prometheusNodeExporter,
    "kube-state-metrics": options?.communityAddons?.kubeStateMetrics,
    "cert-manager": options?.communityAddons?.certManager,
  };
  const awsAddonSettings: Readonly<Record<string, IEksAddonOptions | undefined>> = {
    "aws-efs-csi-driver": options?.awsAddons?.efsCsiDriver,
    "aws-secrets-store-csi-driver-provider": options?.awsAddons?.secretsStoreCsiDriverProvider,
    "amazon-cloudwatch-observability": options?.awsAddons?.cloudWatchObservability,
    "snapshot-controller": options?.awsAddons?.csiSnapshotController,
    "aws-guardduty-agent": options?.awsAddons?.guardDutyAgent,
    "eks-node-monitoring-agent": options?.awsAddons?.nodeMonitoringAgent,
    "aws-mountpoint-s3-csi-driver": options?.awsAddons?.mountpointS3CsiDriver,
    "aws-fsx-csi-driver": options?.awsAddons?.fsxCsiDriver,
  };
  const podIdentityAssociations: Readonly<
    Record<string, Array<{ roleArn: pulumi.Input<string>; serviceAccount: string }> | undefined>
  > = {
    "aws-efs-csi-driver": options?.awsAddons?.efsCsiDriver
      ? [
          {
            roleArn: options.awsAddons.efsCsiDriver.podIdentityRoleArn,
            serviceAccount: "efs-csi-controller-sa",
          },
          ...(options.awsAddons.efsCsiDriver.nodePodIdentityRoleArn
            ? [
                {
                  roleArn: options.awsAddons.efsCsiDriver.nodePodIdentityRoleArn,
                  serviceAccount: "efs-csi-node-sa",
                },
              ]
            : []),
        ]
      : undefined,
    "amazon-cloudwatch-observability": options?.awsAddons?.cloudWatchObservability
      ? [
          {
            roleArn: options.awsAddons.cloudWatchObservability.podIdentityRoleArn,
            serviceAccount: "cloudwatch-agent",
          },
        ]
      : undefined,
    "aws-fsx-csi-driver": options?.awsAddons?.fsxCsiDriver
      ? [
          {
            roleArn: options.awsAddons.fsxCsiDriver.podIdentityRoleArn,
            serviceAccount: "fsx-csi-controller-sa",
          },
        ]
      : undefined,
  };

  validateEksNodePoolScaling(config, { ...options, autoMode });
  const controllerPlacementEnabled = config.nodePools.some(
    (pool) => pool.scaling?.mode === "cluster-autoscaler" || isKarpenterPool(pool)
  );

  if (autoMode && options?.nodeGroupRootDisk) {
    throw new Error("nodeGroupRootDisk applies only to EKS managed node groups, not Auto Mode.");
  }
  if (autoMode && ebsCsiDriver) {
    throw new Error(
      "EKS Auto Mode provides block storage; do not enable the standard EBS CSI add-on."
    );
  }
  if (autoMode && (options?.nodeGroupInstanceTags || options?.nodeGroupAmiType)) {
    throw new Error(
      "nodeGroupInstanceTags and nodeGroupAmiType apply only to managed node groups, not Auto Mode."
    );
  }
  if (autoMode && options?.awsAddons?.nodeMonitoringAgent) {
    throw new Error("EKS Auto Mode already includes the node monitoring agent add-on.");
  }
  if (
    options?.bootstrapClusterCreatorAdminPermissions === false &&
    (!options.clusterAdminRoleArn || authenticationMode === "CONFIG_MAP")
  ) {
    throw new Error(
      "Disabling creator administrator access requires API authentication and a clusterAdminRoleArn principal."
    );
  }
  if (authenticationMode === "CONFIG_MAP" && options?.clusterAdminRoleArn) {
    throw new Error("clusterAdminRoleArn requires API or API_AND_CONFIG_MAP authentication.");
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

  const clusterPolicyAttachment = new aws.iam.RolePolicyAttachment(`${name}-cluster-policy`, {
    policyArn: "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
    role: clusterRole.name,
  });

  // EKS Cluster
  const cluster = new aws.eks.Cluster(
    `${name}-cluster`,
    {
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
      accessConfig: {
        authenticationMode,
        bootstrapClusterCreatorAdminPermissions: options?.bootstrapClusterCreatorAdminPermissions,
      },
      upgradePolicy: options?.upgradePolicy,
      tags: { ...tags, [`kubernetes.io/cluster/${name}`]: "owned" },
    },
    { dependsOn: [clusterPolicyAttachment] }
  );

  // Node pools — Auto Mode delegates to EKS, standard uses managed node groups
  const nodeGroups: aws.eks.NodeGroup[] = [];
  const nodeGroupsByPool = new Map<string, aws.eks.NodeGroup>();

  if (!autoMode) {
    for (const np of config.nodePools) {
      if (isKarpenterPool(np)) {
        continue;
      }
      const managedPool = np as IManagedNodePool;
      const desiredNodes = managedPool.desiredNodes ?? managedPool.minNodes;
      const nodeRole = createNodeRole(`${name}-${managedPool.name}`, tags);
      const launchTemplate =
        options?.nodeGroupRootDisk || options?.nodeGroupInstanceTags
          ? new aws.ec2.LaunchTemplate(`${name}-lt-${managedPool.name}`, {
              blockDeviceMappings: options?.nodeGroupRootDisk
                ? [
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
                  ]
                : undefined,
              tagSpecifications: [
                {
                  resourceType: "instance",
                  tags: {
                    ...tags,
                    ...options?.nodeGroupInstanceTags,
                    "nimbus:cluster": tags["nimbus:cluster"] as string,
                  },
                },
                { resourceType: "volume", tags },
              ],
              tags: { ...tags, Name: `${name}-${np.name}-launch-template` },
            })
          : undefined;
      const nodeGroup = new aws.eks.NodeGroup(
        `${name}-ng-${managedPool.name}`,
        {
          clusterName: cluster.name,
          nodeGroupName: `${name}-${managedPool.name}`,
          nodeRoleArn: nodeRole.role.arn,
          instanceTypes: [managedPool.instanceType],
          capacityType: managedPool.spot ? "SPOT" : "ON_DEMAND",
          amiType: options?.nodeGroupAmiType,
          scalingConfig:
            managedPool.scaling?.mode === "fixed"
              ? {
                  desiredSize: desiredNodes,
                  minSize: desiredNodes,
                  maxSize: Math.max(1, desiredNodes),
                }
              : {
                  desiredSize: desiredNodes,
                  minSize: managedPool.minNodes,
                  maxSize: managedPool.maxNodes,
                },
          subnetIds: (network.natReady
            ? pulumi
                .all([network.privateSubnetIds, network.natReady])
                .apply(([subnetIds]) => subnetIds)
            : network.privateSubnetIds) as pulumi.Output<string[]>,
          labels: {
            ...(managedPool.labels ?? {}),
            ...(controllerPlacementEnabled ? { "nimbus.dev/node-pool": managedPool.name } : {}),
          },
          launchTemplate: launchTemplate
            ? {
                id: launchTemplate.id,
                version: launchTemplate.latestVersion.apply((version) => String(version)),
              }
            : undefined,
          tags: { ...tags, Name: `${name}-${managedPool.name}` },
        },
        {
          dependsOn: [cluster, ...nodeRole.policyAttachments],
          ignoreChanges:
            managedPool.scaling?.mode === "cluster-autoscaler"
              ? ["scalingConfig.desiredSize"]
              : undefined,
        }
      );
      nodeGroups.push(nodeGroup);
      nodeGroupsByPool.set(managedPool.name, nodeGroup);
      new aws.autoscaling.Tag(
        `${name}-node-pool-tag-${managedPool.name}`,
        {
          autoscalingGroupName: nodeGroup.resources.apply(
            (items) => items[0]?.autoscalingGroups[0]?.name ?? ""
          ),
          tag: {
            key: "nimbus:cluster",
            value: tags["nimbus:cluster"] as string,
            propagateAtLaunch: true,
          },
        },
        { dependsOn: [nodeGroup] }
      );
    }
  }

  new aws.ec2.Tag(
    `${name}-cluster-security-group-tag`,
    {
      resourceId: cluster.vpcConfig.apply((vpcConfig) => vpcConfig.clusterSecurityGroupId),
      key: "nimbus:cluster",
      value: tags["nimbus:cluster"] as string,
    },
    { dependsOn: [cluster] }
  );

  // Grant the EBS CSI controller its AWS permissions through EKS Pod Identity.
  let ebsCsiRole: aws.iam.Role | undefined;
  let ebsCsiPolicyAttachment: aws.iam.RolePolicyAttachment | undefined;
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
    ebsCsiPolicyAttachment = new aws.iam.RolePolicyAttachment(`${name}-ebs-csi-policy`, {
      policyArn: "arn:aws:iam::aws:policy/AmazonEBSCSIDriverPolicyV2",
      role: ebsCsiRole.name,
    });
  }

  const usesPodIdentity =
    ebsCsiDriver ||
    config.nodePools.some(isKarpenterPool) ||
    Object.values(podIdentityAssociations).some((associations) => associations !== undefined);

  // Add-on names are deduplicated so the explicit add-on list can include the
  // EBS driver without creating a second copy of it or its Pod Identity agent.
  const addonNames = new Set(addons);
  const metricsServerOption = options?.metricsServer;
  const metricsServerEnabled =
    typeof metricsServerOption === "boolean"
      ? metricsServerOption
      : (metricsServerOption?.enabled ?? metricsServerOption !== undefined);
  if (metricsServerEnabled) {
    addonNames.add("metrics-server");
  } else if (metricsServerOption !== undefined) {
    addonNames.delete("metrics-server");
  }
  const needsPodIdentityAgent = !autoMode && usesPodIdentity;
  if (needsPodIdentityAgent) {
    addonNames.delete("eks-pod-identity-agent");
    addonNames.add("eks-pod-identity-agent");
  }
  for (const [addonName, addonOptions] of Object.entries(communityAddonSettings)) {
    if (addonOptions) addonNames.add(addonName);
  }
  for (const [addonName, addonOptions] of Object.entries(awsAddonSettings)) {
    if (addonOptions) addonNames.add(addonName);
  }
  if (ebsCsiDriver) {
    // Ensure callers that explicitly listed the CSI add-on still get its
    // required Pod Identity agent created first.
    addonNames.delete("aws-ebs-csi-driver");
    addonNames.add("aws-ebs-csi-driver");
  }
  if (needsPodIdentityAgent) addonNames.add("eks-pod-identity-agent");

  // EKS Add-ons
  let podIdentityAgent: aws.eks.Addon | undefined;
  const addonsCreated: aws.eks.Addon[] = [];
  for (const addon of addonNames) {
    const dependsOn: pulumi.Resource[] = [cluster, ...nodeGroups];
    const addonPodIdentityAssociations = podIdentityAssociations[addon];
    if ((addon === "aws-ebs-csi-driver" || addonPodIdentityAssociations) && podIdentityAgent) {
      dependsOn.push(podIdentityAgent);
    }
    if (addon === "aws-ebs-csi-driver" && ebsCsiPolicyAttachment) {
      dependsOn.push(ebsCsiPolicyAttachment);
    }
    const addonResource = new aws.eks.Addon(
      `${name}-addon-${addon}`,
      {
        clusterName: cluster.name,
        addonName: addon,
        addonVersion:
          addon === "metrics-server" && typeof metricsServerOption === "object"
            ? metricsServerOption.addonVersion
            : (communityAddonSettings[addon]?.version ?? awsAddonSettings[addon]?.version),
        configurationValues:
          addon === "metrics-server" && typeof metricsServerOption === "object"
            ? metricsServerOption.configurationValues
            : (communityAddonSettings[addon]?.configurationValues ??
              awsAddonSettings[addon]?.configurationValues),
        resolveConflictsOnCreate: "OVERWRITE",
        resolveConflictsOnUpdate: "OVERWRITE",
        podIdentityAssociations:
          addon === "aws-ebs-csi-driver" && ebsCsiRole
            ? [{ roleArn: ebsCsiRole.arn, serviceAccount: "ebs-csi-controller-sa" }]
            : addonPodIdentityAssociations,
        serviceAccountRoleArn:
          addon === "aws-mountpoint-s3-csi-driver"
            ? options?.awsAddons?.mountpointS3CsiDriver?.serviceAccountRoleArn
            : undefined,
        tags,
      },
      dependsOn.length ? { dependsOn } : undefined
    );
    addonsCreated.push(addonResource);
    if (addon === "eks-pod-identity-agent") podIdentityAgent = addonResource;
  }

  let clusterAdminAssociation: aws.eks.AccessPolicyAssociation | undefined;
  if (options?.clusterAdminRoleArn) {
    const accessEntry = new aws.eks.AccessEntry(
      `${name}-cluster-admin-entry`,
      {
        clusterName: cluster.name,
        principalArn: options.clusterAdminRoleArn,
        type: "STANDARD",
        tags,
      },
      { dependsOn: [cluster] }
    );
    clusterAdminAssociation = new aws.eks.AccessPolicyAssociation(
      `${name}-cluster-admin-policy`,
      {
        clusterName: cluster.name,
        principalArn: options.clusterAdminRoleArn,
        policyArn: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy",
        accessScope: { type: "cluster" },
      },
      { dependsOn: [cluster, accessEntry] }
    );
  }

  // K8s provider for this cluster
  const kubeconfig = pulumi
    .all([
      cluster.endpoint,
      cluster.certificateAuthority,
      cluster.name,
      options?.kubernetesProviderRoleArn,
    ])
    .apply(([endpoint, ca, clusterName, providerRoleArn]) => {
      const tokenArgs = ["eks", "get-token", "--cluster-name", clusterName];
      if (providerRoleArn) tokenArgs.push("--role-arn", providerRoleArn);
      return JSON.stringify({
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
                args: tokenArgs,
              },
            },
          },
        ],
      });
    });

  const provider = new k8s.Provider(
    `${name}-k8s`,
    {
      kubeconfig,
    },
    {
      dependsOn: [
        cluster,
        ...nodeGroups,
        ...addonsCreated,
        ...(clusterAdminAssociation ? [clusterAdminAssociation] : []),
      ],
    }
  );

  createEksAutoscaling(
    name,
    cluster,
    provider,
    network,
    config.nodePools,
    options ?? {},
    nodeGroupsByPool,
    podIdentityAgent,
    cluster.version,
    tags
  );

  return withClusterFluentOperations({
    name,
    cloud: target,
    endpoint: cluster.endpoint,
    kubeconfig,
    version: cluster.version,
    nodePools: config.nodePools,
    storageTiers: config.storageTiers,
    nativeResource: cluster,
    provider,
    providerResources: podIdentityAgent ? { podIdentityAgent } : undefined,
    eksAddons: [...addonNames],
    awsResourceTags: tags,
    awsVpcId: network.vpcId,
    awsRegion: aws.config.region ?? target.region,
  });
}

function createNodeRole(
  name: string,
  tags: Readonly<Record<string, string>>
): { role: aws.iam.Role; policyAttachments: aws.iam.RolePolicyAttachment[] } {
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

  const policyAttachments = policies.map((policyArn) => {
    const shortName = policyArn.split("/").pop() ?? policyArn;
    return new aws.iam.RolePolicyAttachment(`${name}-${shortName}`, {
      policyArn,
      role: role.name,
    });
  });

  return { role, policyAttachments };
}
