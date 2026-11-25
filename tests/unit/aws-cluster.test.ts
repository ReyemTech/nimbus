import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IClusterConfig } from "../../src/cluster";
import type { INetwork } from "../../src/network";
import type { IEksOptions } from "../../src/aws/cluster";

const mockPulumi = vi.hoisted(() => {
  const output = (
    value: unknown
  ): { __mockOutput: true; value: unknown; apply: (fn: (v: unknown) => unknown) => unknown } => ({
    __mockOutput: true,
    value,
    apply: (fn) => output(fn(value)),
  });

  const allCalls: ReadonlyArray<unknown>[] = [];
  const clusterArn = { value: "arn:aws:eks:us-east-1:123456789012:cluster/prod" };
  const clusterIssuer = {
    value: "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE",
  };
  return {
    allCalls,
    clusterArn,
    clusterIssuer,
    output,
    all: (values: ReadonlyArray<unknown>) => {
      allCalls.push(values);
      return output(
        values.map((value) =>
          typeof value === "object" && value !== null && "__mockOutput" in value
            ? (value as unknown as { value: unknown }).value
            : value
        )
      );
    },
  };
});

const constructed = vi.hoisted(() => ({
  resources: [] as Array<{
    kind: string;
    name: string;
    args: Record<string, unknown>;
    opts?: unknown;
  }>,
}));

vi.mock("@pulumi/pulumi", () => mockPulumi);

vi.mock("@pulumi/kubernetes", () => ({
  Provider: class {
    readonly kind = "k8s.Provider";
    constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
      constructed.resources.push({ kind: "k8s.Provider", name, args, opts });
    }
  },
  helm: {
    v3: {
      Chart: class {
        readonly kind = "k8s.Chart";
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
          constructed.resources.push({ kind: "k8s.Chart", name, args, opts });
        }
      },
      Release: class {
        readonly kind = "k8s.Release";
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
          constructed.resources.push({ kind: "k8s.Release", name, args, opts });
        }
      },
    },
  },
  apiextensions: {
    CustomResource: class {
      readonly kind = "k8s.CustomResource";
      constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
        constructed.resources.push({ kind: "k8s.CustomResource", name, args, opts });
      }
    },
  },
  core: {
    v1: {
      Namespace: class {
        readonly kind = "k8s.Namespace";
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
          constructed.resources.push({ kind: "k8s.Namespace", name, args, opts });
        }
      },
    },
  },
}));

vi.mock("@pulumi/aws", () => {
  const record = (kind: string, name: string, args: Record<string, unknown>, opts?: unknown) => {
    constructed.resources.push({ kind, name, args, opts });
  };
  const output = mockPulumi.output;

  return {
    iam: {
      Role: class {
        readonly name = output("mock-role-name");
        readonly arn = output("arn:aws:iam::123456789012:role/mock-role");
        constructor(name: string, args: Record<string, unknown>) {
          record("iam.Role", name, args);
        }
      },
      RolePolicyAttachment: class {
        readonly kind = "iam.RolePolicyAttachment";
        constructor(name: string, args: Record<string, unknown>) {
          record("iam.RolePolicyAttachment", name, args);
        }
      },
      RolePolicy: class {
        readonly kind = "iam.RolePolicy";
        constructor(name: string, args: Record<string, unknown>) {
          record("iam.RolePolicy", name, args);
        }
      },
      OpenIdConnectProvider: class {
        readonly kind = "iam.OpenIdConnectProvider";
        readonly arn = output(
          `arn:aws:iam::123456789012:oidc-provider/${mockPulumi.clusterIssuer.value.replace("https://", "")}`
        );
        readonly url = output(mockPulumi.clusterIssuer.value);
        constructor(name: string, args: Record<string, unknown>) {
          record("iam.OpenIdConnectProvider", name, args);
        }
      },
    },
    ec2: {
      LaunchTemplate: class {
        readonly id = output("lt-123");
        readonly latestVersion = output(7);
        constructor(name: string, args: Record<string, unknown>) {
          record("ec2.LaunchTemplate", name, args);
        }
      },
    },
    eks: {
      Cluster: class {
        readonly kind = "eks.Cluster";
        readonly name = output("prod");
        readonly arn = output(mockPulumi.clusterArn.value);
        readonly identities = output([
          {
            oidcs: [{ issuer: mockPulumi.clusterIssuer.value }],
          },
        ]);
        readonly endpoint = output("https://eks.example.com");
        readonly certificateAuthority = output({ data: "mock-ca" });
        readonly version = output("1.32");
        readonly vpcConfig = output({ clusterSecurityGroupId: "sg-cluster" });
        constructor(name: string, args: Record<string, unknown>) {
          record("eks.Cluster", name, args);
        }
      },
      NodeGroup: class {
        readonly kind = "eks.NodeGroup";
        readonly resources: ReturnType<typeof output>;
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
          this.resources = output([{ autoscalingGroups: [{ name: `asg-${name}` }] }]);
          record("eks.NodeGroup", name, args, opts);
        }
      },
      Addon: class {
        readonly kind = "eks.Addon";
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
          record("eks.Addon", name, args, opts);
        }
      },
      AccessEntry: class {
        readonly kind = "eks.AccessEntry";
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
          record("eks.AccessEntry", name, args, opts);
        }
      },
      AccessPolicyAssociation: class {
        readonly kind = "eks.AccessPolicyAssociation";
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
          record("eks.AccessPolicyAssociation", name, args, opts);
        }
      },
      PodIdentityAssociation: class {
        readonly kind = "eks.PodIdentityAssociation";
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
          record("eks.PodIdentityAssociation", name, args, opts);
        }
      },
    },
    autoscaling: {
      Tag: class {
        readonly kind = "autoscaling.Tag";
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
          record("autoscaling.Tag", name, args, opts);
        }
      },
    },
    sqs: {
      Queue: class {
        readonly arn = output("arn:aws:sqs:us-east-1:123456789012:prod-karpenter-interruption");
        readonly name = output("prod-karpenter-interruption");
        readonly url = output(
          "https://sqs.us-east-1.amazonaws.com/123456789012/prod-karpenter-interruption"
        );
        constructor(name: string, args: Record<string, unknown>) {
          record("sqs.Queue", name, args);
        }
      },
      QueuePolicy: class {
        readonly kind = "sqs.QueuePolicy";
        constructor(name: string, args: Record<string, unknown>) {
          record("sqs.QueuePolicy", name, args);
        }
      },
    },
    cloudwatch: {
      EventRule: class {
        readonly name = output("rule");
        constructor(name: string, args: Record<string, unknown>) {
          record("cloudwatch.EventRule", name, args);
        }
      },
      EventTarget: class {
        readonly kind = "cloudwatch.EventTarget";
        constructor(name: string, args: Record<string, unknown>) {
          record("cloudwatch.EventTarget", name, args);
        }
      },
    },
  };
});

import { createEksCluster } from "../../src/aws/cluster";

const baseNodePool = {
  name: "workers",
  instanceType: "m7i.large",
  minNodes: 1,
  maxNodes: 3,
} as const;

const config = {
  cloud: "aws",
  version: "1.32",
  nodePools: [baseNodePool],
} satisfies IClusterConfig;

const network = {
  name: "prod-network",
  cloud: { provider: "aws", region: "us-east-1" },
  vpcId: mockPulumi.output("vpc-123"),
  cidr: "10.0.0.0/16",
  publicSubnetIds: mockPulumi.output(["subnet-public"]),
  privateSubnetIds: mockPulumi.output(["subnet-private"]),
  privateSubnetAvailabilityZones: mockPulumi.output(["us-east-1a"]),
  nativeResource: {} as INetwork["nativeResource"],
} as unknown as INetwork;

const create = (
  options?: IEksOptions,
  networkOverride: INetwork = network,
  clusterConfig: IClusterConfig = config
) => createEksCluster("prod", clusterConfig, networkOverride, options);

const resourcesOf = (kind: string) => constructed.resources.filter((item) => item.kind === kind);

beforeEach(() => {
  constructed.resources.length = 0;
  mockPulumi.allCalls.length = 0;
  mockPulumi.clusterArn.value = "arn:aws:eks:us-east-1:123456789012:cluster/prod";
  mockPulumi.clusterIssuer.value = "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE";
});

describe("createEksCluster options", () => {
  it("does not install Metrics Server when omitted, false, or disabled in its options", () => {
    create({ metricsServer: false });
    expect(resourcesOf("eks.Addon").map(({ args }) => args.addonName)).not.toContain(
      "metrics-server"
    );

    constructed.resources.length = 0;
    create({ metricsServer: { enabled: false } });
    expect(resourcesOf("eks.Addon").map(({ args }) => args.addonName)).not.toContain(
      "metrics-server"
    );
  });

  it("installs Metrics Server as an EKS add-on after the cluster when enabled", () => {
    create({ metricsServer: true });

    const metricsServer = resourcesOf("eks.Addon").find(
      ({ args }) => args.addonName === "metrics-server"
    );
    expect(metricsServer).toBeDefined();
    expect(metricsServer?.args).toMatchObject({ addonName: "metrics-server" });
    expect(metricsServer?.args.addonVersion).toBeUndefined();
    expect(metricsServer?.args.configurationValues).toBeUndefined();
    expect(metricsServer?.opts).toMatchObject({
      dependsOn: expect.arrayContaining([expect.objectContaining({ kind: "eks.Cluster" })]),
    });
    expect(
      resourcesOf("eks.Addon").filter(({ args }) => args.addonName === "metrics-server")
    ).toHaveLength(1);
    expect(resourcesOf("k8s.Provider")[0]?.opts).toMatchObject({
      dependsOn: expect.arrayContaining([expect.objectContaining({ kind: "eks.Addon" })]),
    });
  });

  it("passes a requested Metrics Server version and configuration to EKS", () => {
    create({
      metricsServer: {
        addonVersion: "v0.7.2-eksbuild.1",
        configurationValues: JSON.stringify({ replicas: 2 }),
      },
    });

    const metricsServer = resourcesOf("eks.Addon").find(
      ({ args }) => args.addonName === "metrics-server"
    );
    expect(metricsServer?.args).toMatchObject({
      addonName: "metrics-server",
      addonVersion: "v0.7.2-eksbuild.1",
      configurationValues: JSON.stringify({ replicas: 2 }),
    });
  });

  it("returns configured storage tiers to downstream consumers", () => {
    const storageTiers = { standard: "gp3", performance: "gp3-encrypted" } as const;

    const cluster = createEksCluster("prod", { ...config, storageTiers }, network);

    expect(cluster.storageTiers).toEqual(storageTiers);
  });

  it("preserves defaults when the new options are omitted", () => {
    create();

    expect(resourcesOf("eks.Cluster")[0]?.args.vpcConfig).toMatchObject({
      endpointPublicAccess: true,
      endpointPrivateAccess: true,
      publicAccessCidrs: undefined,
    });
    expect(resourcesOf("eks.Cluster")[0]?.args.accessConfig).toEqual({
      authenticationMode: "API_AND_CONFIG_MAP",
      bootstrapClusterCreatorAdminPermissions: undefined,
    });
    expect(resourcesOf("eks.Cluster")[0]?.args.upgradePolicy).toBeUndefined();
    expect(resourcesOf("eks.Addon").map(({ args }) => args.addonName)).toEqual([
      "vpc-cni",
      "coredns",
      "kube-proxy",
    ]);
    expect(resourcesOf("eks.NodeGroup")[0]?.args.launchTemplate).toBeUndefined();
    expect(resourcesOf("eks.AccessEntry")).toHaveLength(0);
    expect(resourcesOf("ec2.LaunchTemplate")).toHaveLength(0);
    expect(resourcesOf("iam.Role")).toHaveLength(2); // cluster and node roles
    const nodeGroupDependencies = (
      resourcesOf("eks.NodeGroup")[0]?.opts as { dependsOn?: Array<{ kind?: string }> } | undefined
    )?.dependsOn;
    expect(nodeGroupDependencies?.some(({ kind }) => kind === "eks.Cluster")).toBe(true);
    expect(
      resourcesOf("eks.Addon").every(
        ({ opts }) => (opts as { dependsOn?: unknown[] } | undefined)?.dependsOn?.length
      )
    ).toBe(true);
    expect(
      resourcesOf("eks.Addon").every(({ opts }) =>
        ((opts as { dependsOn?: Array<{ kind?: string }> } | undefined)?.dependsOn ?? []).some(
          ({ kind }) => kind === "eks.Cluster"
        )
      )
    ).toBe(true);
    expect(resourcesOf("k8s.Provider")[0]?.opts).toMatchObject({
      dependsOn: expect.arrayContaining([
        expect.objectContaining({ kind: "eks.Cluster" }),
        expect.objectContaining({ kind: "eks.NodeGroup" }),
        expect.objectContaining({ kind: "eks.Addon" }),
      ]),
    });
  });

  it("configures EKS authentication, creator bootstrap, and upgrade support policy", () => {
    create({
      authenticationMode: "API",
      bootstrapClusterCreatorAdminPermissions: false,
      clusterAdminRoleArn: "arn:aws:iam::123456789012:user/eks-admin",
      upgradePolicy: { supportType: "STANDARD" },
    });

    expect(resourcesOf("eks.Cluster")[0]?.args.accessConfig).toEqual({
      authenticationMode: "API",
      bootstrapClusterCreatorAdminPermissions: false,
    });
    expect(resourcesOf("eks.Cluster")[0]?.args.upgradePolicy).toEqual({ supportType: "STANDARD" });
    expect(resourcesOf("eks.AccessEntry")[0]?.opts).toMatchObject({
      dependsOn: [expect.objectContaining({ kind: "eks.Cluster" })],
    });
    expect(resourcesOf("eks.AccessPolicyAssociation")[0]?.opts).toMatchObject({
      dependsOn: expect.arrayContaining([
        expect.objectContaining({ kind: "eks.Cluster" }),
        expect.objectContaining({ kind: "eks.AccessEntry" }),
      ]),
    });
    expect(resourcesOf("k8s.Provider")[0]?.opts).toMatchObject({
      dependsOn: expect.arrayContaining([
        expect.objectContaining({ kind: "eks.AccessPolicyAssociation" }),
      ]),
    });
  });

  it("configures the Kubernetes provider to assume the granted admin role", () => {
    const cluster = create({
      authenticationMode: "API",
      bootstrapClusterCreatorAdminPermissions: false,
      clusterAdminRoleArn: "arn:aws:iam::123456789012:role/platform-admin",
      kubernetesProviderRoleArn: "arn:aws:iam::123456789012:role/platform-admin",
    });
    const kubeconfigOutput = cluster.kubeconfig as unknown as { value: string };
    const kubeconfig = JSON.parse(kubeconfigOutput.value) as {
      users: Array<{ user: { exec: { args: string[] } } }>;
    };

    expect(kubeconfig.users[0]?.user.exec.args).toEqual([
      "eks",
      "get-token",
      "--cluster-name",
      "prod",
      "--role-arn",
      "arn:aws:iam::123456789012:role/platform-admin",
    ]);
  });

  it("requires an API access principal when creator admin bootstrap is disabled", () => {
    expect(() =>
      create({ authenticationMode: "API", bootstrapClusterCreatorAdminPermissions: false })
    ).toThrow(/requires API authentication and a clusterAdminRoleArn principal/);
  });

  it("waits for NAT readiness before creating private node groups", () => {
    const natReady = mockPulumi.output(true) as unknown as NonNullable<INetwork["natReady"]>;
    create(undefined, { ...network, natReady });

    expect(
      mockPulumi.allCalls.some(
        (values) =>
          values.length === 2 && values[0] === network.privateSubnetIds && values[1] === natReady
      )
    ).toBe(true);
  });

  it("restricts the public API endpoint and grants the supplied role cluster-admin", () => {
    create({
      endpointAccess: "public",
      publicAccessCidrs: ["203.0.113.0/24", "198.51.100.7/32"],
      clusterAdminRoleArn: "arn:aws:iam::123456789012:role/platform-admin",
    });

    expect(resourcesOf("eks.Cluster")[0]?.args.vpcConfig).toMatchObject({
      endpointPublicAccess: true,
      endpointPrivateAccess: false,
      publicAccessCidrs: ["203.0.113.0/24", "198.51.100.7/32"],
    });
    expect(resourcesOf("eks.AccessEntry")[0]?.args).toMatchObject({
      principalArn: "arn:aws:iam::123456789012:role/platform-admin",
      type: "STANDARD",
    });
    expect(resourcesOf("eks.AccessPolicyAssociation")[0]?.args).toMatchObject({
      principalArn: "arn:aws:iam::123456789012:role/platform-admin",
      policyArn: "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy",
      accessScope: { type: "cluster" },
    });
    expect(resourcesOf("eks.AccessPolicyAssociation")[0]?.opts).toMatchObject({
      dependsOn: expect.arrayContaining([
        expect.objectContaining({ kind: "eks.Cluster" }),
        expect.objectContaining({ kind: "eks.AccessEntry" }),
      ]),
    });
  });

  it("uses an encrypted gp3 launch-template root disk for managed node groups", () => {
    create({ nodeGroupRootDisk: { sizeGiB: 80, deleteOnTermination: false } });

    expect(resourcesOf("ec2.LaunchTemplate")[0]?.args.blockDeviceMappings).toEqual([
      {
        deviceName: "/dev/xvda",
        ebs: {
          volumeSize: 80,
          volumeType: "gp3",
          encrypted: "true",
          deleteOnTermination: "false",
        },
      },
    ]);
    expect(resourcesOf("eks.NodeGroup")[0]?.args.launchTemplate).toMatchObject({
      id: { value: "lt-123" },
      version: { value: "7" },
    });
  });

  it("installs EBS CSI with Pod Identity permissions and its agent", () => {
    create({ addons: ["aws-ebs-csi-driver"] });

    const addonNames = resourcesOf("eks.Addon").map(({ args }) => args.addonName);
    expect(addonNames).toContain("eks-pod-identity-agent");
    expect(addonNames).toContain("aws-ebs-csi-driver");
    expect(addonNames.indexOf("eks-pod-identity-agent")).toBeLessThan(
      addonNames.indexOf("aws-ebs-csi-driver")
    );
    expect(
      resourcesOf("eks.Addon").find(({ args }) => args.addonName === "aws-ebs-csi-driver")?.args
    ).toMatchObject({
      podIdentityAssociations: [
        {
          roleArn: { value: "arn:aws:iam::123456789012:role/mock-role" },
          serviceAccount: "ebs-csi-controller-sa",
        },
      ],
    });
    expect(resourcesOf("iam.RolePolicyAttachment").map(({ args }) => args.policyArn)).toContain(
      "arn:aws:iam::aws:policy/AmazonEBSCSIDriverPolicyV2"
    );
    expect(
      resourcesOf("iam.Role").find(({ name }) => name === "prod-ebs-csi-role")?.args
    ).toMatchObject({
      assumeRolePolicy: expect.stringContaining('"pods.eks.amazonaws.com"'),
    });
    const csiAddon = resourcesOf("eks.Addon").find(
      ({ args }) => args.addonName === "aws-ebs-csi-driver"
    );
    expect(
      (csiAddon?.opts as { dependsOn?: Array<{ kind?: string }> } | undefined)?.dependsOn?.some(
        ({ kind }) => kind === "iam.RolePolicyAttachment"
      )
    ).toBe(true);
  });

  it("installs selected AWS add-ons with their IAM bindings and Pod Identity agent", () => {
    create({
      awsAddons: {
        efsCsiDriver: {
          podIdentityRoleArn: "arn:aws:iam::123456789012:role/efs-controller",
          nodePodIdentityRoleArn: "arn:aws:iam::123456789012:role/efs-node",
        },
        secretsStoreCsiDriverProvider: { version: "v1.0.0-eksbuild.1" },
        cloudWatchObservability: {
          podIdentityRoleArn: "arn:aws:iam::123456789012:role/cloudwatch",
        },
        csiSnapshotController: {},
        guardDutyAgent: {},
        nodeMonitoringAgent: {},
        mountpointS3CsiDriver: {
          serviceAccountRoleArn: "arn:aws:iam::123456789012:role/s3-csi",
        },
        fsxCsiDriver: { podIdentityRoleArn: "arn:aws:iam::123456789012:role/fsx" },
      },
    });

    const addons = resourcesOf("eks.Addon");
    const addonNames = addons.map(({ args }) => args.addonName);
    expect(addonNames).toEqual(
      expect.arrayContaining([
        "eks-pod-identity-agent",
        "aws-efs-csi-driver",
        "aws-secrets-store-csi-driver-provider",
        "amazon-cloudwatch-observability",
        "snapshot-controller",
        "aws-guardduty-agent",
        "eks-node-monitoring-agent",
        "aws-mountpoint-s3-csi-driver",
        "aws-fsx-csi-driver",
      ])
    );

    const podIdentityAgentIndex = addonNames.indexOf("eks-pod-identity-agent");
    for (const addonName of [
      "aws-efs-csi-driver",
      "amazon-cloudwatch-observability",
      "aws-fsx-csi-driver",
    ]) {
      const addon = addons.find(({ args }) => args.addonName === addonName);
      expect(addon?.opts).toMatchObject({
        dependsOn: expect.arrayContaining([expect.objectContaining({ kind: "eks.Addon" })]),
      });
      expect(addonNames.indexOf(addonName)).toBeGreaterThan(podIdentityAgentIndex);
    }
    expect(addons.find(({ args }) => args.addonName === "aws-efs-csi-driver")?.args).toMatchObject({
      podIdentityAssociations: [
        {
          roleArn: "arn:aws:iam::123456789012:role/efs-controller",
          serviceAccount: "efs-csi-controller-sa",
        },
        {
          roleArn: "arn:aws:iam::123456789012:role/efs-node",
          serviceAccount: "efs-csi-node-sa",
        },
      ],
    });
    expect(
      addons.find(({ args }) => args.addonName === "amazon-cloudwatch-observability")?.args
    ).toMatchObject({
      podIdentityAssociations: [
        {
          roleArn: "arn:aws:iam::123456789012:role/cloudwatch",
          serviceAccount: "cloudwatch-agent",
        },
      ],
    });
    expect(
      addons.find(({ args }) => args.addonName === "aws-mountpoint-s3-csi-driver")?.args
    ).toMatchObject({ serviceAccountRoleArn: "arn:aws:iam::123456789012:role/s3-csi" });
  });

  it("propagates managed node-group EC2 instance tags through a launch template", () => {
    create({
      nodeGroupInstanceTags: { Name: "reyemtech-public-arm64", environment: "production" },
    });

    expect(resourcesOf("ec2.LaunchTemplate")[0]?.args.tagSpecifications).toEqual([
      {
        resourceType: "instance",
        tags: { Name: "reyemtech-public-arm64", environment: "production" },
      },
    ]);
    expect(resourcesOf("eks.NodeGroup")[0]?.args.launchTemplate).toBeDefined();
  });

  it("passes a configured AMI family to managed node groups", () => {
    create({ nodeGroupAmiType: "AL2023_ARM_64_STANDARD" });

    expect(resourcesOf("eks.NodeGroup")[0]?.args.amiType).toBe("AL2023_ARM_64_STANDARD");
  });

  it("rejects managed-node-group root disks in Auto Mode", () => {
    expect(() => create({ autoMode: true, nodeGroupRootDisk: { sizeGiB: 80 } })).toThrow(
      /only to EKS managed node groups/
    );
  });

  it("pins fixed managed pools to one desired capacity", () => {
    create(undefined, network, {
      ...config,
      nodePools: [{ ...baseNodePool, desiredNodes: 2, scaling: { mode: "fixed" } }],
    });
    expect(resourcesOf("eks.NodeGroup")[0]?.args.scalingConfig).toEqual({
      desiredSize: 2,
      minSize: 2,
      maxSize: 2,
    });
    expect(resourcesOf("k8s.Chart")).toHaveLength(0);
  });

  it("keeps zero-node fixed pools valid for the EKS scaling API", () => {
    create(undefined, network, {
      ...config,
      nodePools: [{ ...baseNodePool, minNodes: 0, maxNodes: 10, scaling: { mode: "fixed" } }],
    });

    expect(resourcesOf("eks.NodeGroup")[0]?.args.scalingConfig).toEqual({
      desiredSize: 0,
      minSize: 0,
      maxSize: 1,
    });
  });

  it("limits Cluster Autoscaler discovery to selected managed pools", () => {
    create({ autoscalerControllerNodePoolName: "steady" }, network, {
      ...config,
      nodePools: [
        {
          name: "steady",
          instanceType: "m7i.large",
          minNodes: 1,
          maxNodes: 4,
          scaling: { mode: "cluster-autoscaler" },
        },
        {
          name: "platform",
          instanceType: "m7i.large",
          minNodes: 1,
          maxNodes: 2,
          scaling: { mode: "cluster-autoscaler" },
        },
        {
          name: "fixed",
          instanceType: "m7i.large",
          minNodes: 1,
          maxNodes: 1,
          scaling: { mode: "fixed" },
        },
        {
          name: "legacy",
          instanceType: "m7i.large",
          minNodes: 1,
          maxNodes: 3,
        },
      ],
    });
    expect(resourcesOf("autoscaling.Tag")).toHaveLength(2);
    expect(
      resourcesOf("autoscaling.Tag").map(
        ({ args }) => (args.autoscalingGroupName as { value: string }).value
      )
    ).toEqual(["asg-prod-ng-steady", "asg-prod-ng-platform"]);
    expect(resourcesOf("autoscaling.Tag").map(({ args }) => args.tag)).toEqual([
      {
        key: "nimbus.dev/cluster-autoscaler/prod",
        value: "owned",
        propagateAtLaunch: false,
      },
      {
        key: "nimbus.dev/cluster-autoscaler/prod",
        value: "owned",
        propagateAtLaunch: false,
      },
    ]);
    expect(resourcesOf("k8s.Chart").map(({ name }) => name)).toContain("prod-cluster-autoscaler");
    expect(
      resourcesOf("k8s.Chart").find(({ name }) => name === "prod-cluster-autoscaler")?.args.values
    ).toMatchObject({
      autoDiscovery: {
        clusterName: "prod",
        tags: ["nimbus.dev/cluster-autoscaler/prod"],
      },
    });
    expect(
      resourcesOf("k8s.Chart").find(({ name }) => name === "prod-cluster-autoscaler")?.args.version
    ).toMatchObject({ value: "9.46.6" });
    expect(resourcesOf("eks.PodIdentityAssociation")).toHaveLength(0);
    expect(resourcesOf("iam.OpenIdConnectProvider")).toHaveLength(1);
    expect(resourcesOf("iam.OpenIdConnectProvider")[0]?.args).toMatchObject({
      url: { value: "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE" },
      clientIdLists: ["sts.amazonaws.com"],
    });
    const caRole = resourcesOf("iam.Role").find(
      ({ name }) => name === "prod-cluster-autoscaler-role"
    );
    const caTrust = JSON.parse((caRole?.args.assumeRolePolicy as { value: string }).value) as {
      Statement: Array<{
        Action: string;
        Principal: { Federated: string };
        Condition: { StringEquals: Record<string, string> };
      }>;
    };
    expect(caTrust.Statement[0]).toMatchObject({
      Action: "sts:AssumeRoleWithWebIdentity",
      Principal: {
        Federated:
          "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE",
      },
      Condition: {
        StringEquals: {
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE:aud": "sts.amazonaws.com",
          "oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE:sub":
            "system:serviceaccount:kube-system:cluster-autoscaler",
        },
      },
    });
    const caChart = resourcesOf("k8s.Chart").find(({ name }) => name === "prod-cluster-autoscaler");
    expect(
      (
        caChart?.args.values as {
          rbac: {
            serviceAccount: { annotations: { "eks.amazonaws.com/role-arn": { value: string } } };
          };
        }
      ).rbac.serviceAccount.annotations["eks.amazonaws.com/role-arn"].value
    ).toBe("arn:aws:iam::123456789012:role/mock-role");
    expect(resourcesOf("eks.Addon").map(({ args }) => args.addonName)).not.toContain(
      "eks-pod-identity-agent"
    );
    const caPolicy = resourcesOf("iam.RolePolicy").find(({ name }) =>
      name.includes("cluster-autoscaler-policy")
    );
    const caPolicyDocument = JSON.parse((caPolicy?.args.policy as { value: string }).value) as {
      Statement: Array<{
        Action: string[];
        Condition?: { StringEquals?: Record<string, string> };
      }>;
    };
    const caWriteStatement = caPolicyDocument.Statement.find((statement) =>
      statement.Action.includes("autoscaling:SetDesiredCapacity")
    );
    expect(caWriteStatement?.Condition?.StringEquals).toEqual({
      "autoscaling:ResourceTag/nimbus.dev/cluster-autoscaler/prod": "owned",
    });
    expect(
      resourcesOf("eks.NodeGroup").find(({ name }) => name === "prod-ng-steady")?.opts
    ).toMatchObject({ ignoreChanges: ["scalingConfig.desiredSize"] });
    expect(
      (
        resourcesOf("eks.NodeGroup").find(({ name }) => name === "prod-ng-fixed")?.opts as
          | { ignoreChanges?: string[] }
          | undefined
      )?.ignoreChanges
    ).toBeUndefined();
  });

  it("uses a caller-owned OIDC provider for Cluster Autoscaler IRSA", () => {
    const oidcProviderArn =
      "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE";
    create(
      {
        autoscalerControllerNodePoolName: "steady",
        clusterAutoscaler: { oidcProviderArn },
      },
      network,
      {
        ...config,
        nodePools: [
          {
            name: "steady",
            instanceType: "m7i.large",
            minNodes: 1,
            maxNodes: 2,
            scaling: { mode: "cluster-autoscaler" },
          },
        ],
      }
    );

    expect(resourcesOf("iam.OpenIdConnectProvider")).toHaveLength(0);
    const role = resourcesOf("iam.Role").find(
      ({ name }) => name === "prod-cluster-autoscaler-role"
    );
    const trust = JSON.parse((role?.args.assumeRolePolicy as { value: string }).value) as {
      Statement: Array<{ Principal: { Federated: string } }>;
    };
    expect(trust.Statement[0]?.Principal.Federated).toBe(oidcProviderArn);
  });

  it("keeps Karpenter capacity separate from EKS managed groups and Cluster Autoscaler", () => {
    const dualAzNetwork = {
      ...network,
      privateSubnetIds: mockPulumi.output(["subnet-private-a", "subnet-private-b"]),
      privateSubnetAvailabilityZones: mockPulumi.output(["us-east-1a", "us-east-1b"]),
    } as unknown as INetwork;
    create({ autoscalerControllerNodePoolName: "steady" }, dualAzNetwork, {
      ...config,
      nodePools: [
        {
          name: "steady",
          instanceType: "m7i.large",
          minNodes: 1,
          maxNodes: 4,
          scaling: { mode: "cluster-autoscaler" },
        },
        {
          name: "burst",
          labels: { workload: "batch" },
          scaling: {
            mode: "karpenter",
            instanceTypes: ["m7i.large", "m7i.xlarge"],
            capacityTypes: ["spot"],
            availabilityZones: ["us-east-1a"],
            limits: { cpu: "100" },
          },
        },
        {
          name: "unrestricted",
          scaling: { mode: "karpenter", instanceTypes: ["m7i.large"] },
        },
      ],
    });
    expect(resourcesOf("eks.NodeGroup")).toHaveLength(1);
    const karpenterRelease = resourcesOf("k8s.Release").find(
      ({ name }) => name === "prod-karpenter"
    );
    expect((karpenterRelease?.args.values as { replicas?: number } | undefined)?.replicas).toBe(1);
    expect(resourcesOf("autoscaling.Tag")).toHaveLength(1);
    expect(
      resourcesOf("autoscaling.Tag").every(({ args }) =>
        (args.autoscalingGroupName as { value: string }).value.includes("steady")
      )
    ).toBe(true);
    const karpenterPool = resourcesOf("k8s.CustomResource").find(({ name }) =>
      name.includes("pool-burst")
    );
    expect(karpenterPool?.args.spec).toMatchObject({
      template: {
        spec: {
          requirements: [
            { key: "node.kubernetes.io/instance-type", values: ["m7i.large", "m7i.xlarge"] },
            { key: "karpenter.sh/capacity-type", values: ["spot"] },
            { key: "topology.kubernetes.io/zone", values: ["us-east-1a"] },
          ],
        },
      },
      limits: { cpu: "100" },
    });
    const nodeClass = resourcesOf("k8s.CustomResource").find(({ name }) =>
      name.includes("nodeclass")
    );
    expect(
      (nodeClass?.args.spec as { subnetSelectorTerms: { value: Array<{ id: string }> } })
        .subnetSelectorTerms.value
    ).toEqual([{ id: "subnet-private-a" }, { id: "subnet-private-b" }]);
    const unrestrictedPool = resourcesOf("k8s.CustomResource").find(({ name }) =>
      name.includes("pool-unrestricted")
    );
    expect(JSON.stringify(unrestrictedPool?.args.spec)).not.toContain(
      "topology.kubernetes.io/zone"
    );
    expect(
      (nodeClass?.args.spec as { securityGroupSelectorTerms: Array<{ id: { value: string } }> })
        .securityGroupSelectorTerms[0]?.id.value
    ).toBe("sg-cluster");
    const karpenterPolicy = resourcesOf("iam.RolePolicy").find(({ name }) =>
      name.includes("karpenter-controller-policy")
    );
    const karpenterPolicyDocument = JSON.parse(
      (karpenterPolicy?.args.policy as { value: string }).value
    ) as {
      Statement: Array<{
        Action: string | string[];
        Resource: string | string[];
        Condition?: Record<string, Record<string, unknown>>;
      }>;
    };
    expect(JSON.stringify(karpenterPolicyDocument)).not.toContain("autoscaling:SetDesiredCapacity");
    expect(
      karpenterPolicyDocument.Statement.find((statement) => statement.Action === "iam:PassRole")
        ?.Resource
    ).toBe("arn:aws:iam::123456789012:role/mock-role");
    const terminateStatement = karpenterPolicyDocument.Statement.find((statement) =>
      (Array.isArray(statement.Action) ? statement.Action : [statement.Action]).includes(
        "ec2:TerminateInstances"
      )
    );
    expect(terminateStatement?.Resource).toEqual(
      expect.arrayContaining([
        "arn:aws:ec2:us-east-1:*:instance/*",
        "arn:aws:ec2:us-east-1:*:launch-template/*",
      ])
    );
    expect(JSON.stringify(terminateStatement?.Condition)).toContain("karpenter.sh/nodepool");
    const caPolicy = resourcesOf("iam.RolePolicy").find(({ name }) =>
      name.includes("cluster-autoscaler-policy")
    );
    expect(JSON.stringify(caPolicy?.args.policy)).toContain("autoscaling:SetDesiredCapacity");
    expect(resourcesOf("sqs.Queue")).toHaveLength(1);
    expect(resourcesOf("cloudwatch.EventRule")).toHaveLength(5);
    expect(
      JSON.parse(resourcesOf("cloudwatch.EventRule")[0]?.args.eventPattern as string)
    ).toHaveProperty("detail-type");
    expect(resourcesOf("cloudwatch.EventTarget")).toHaveLength(5);
    expect(JSON.stringify(karpenterPolicy?.args.policy)).toContain("sqs:ReceiveMessage");
  });

  it("uses the deployed cluster region for autoscaler configuration and IAM", () => {
    mockPulumi.clusterArn.value = "arn:aws:eks:ca-central-1:123456789012:cluster/prod";
    mockPulumi.clusterIssuer.value = "https://oidc.eks.ca-central-1.amazonaws.com/id/EXAMPLE";
    create({ autoscalerControllerNodePoolName: "steady" }, network, {
      ...config,
      nodePools: [
        {
          name: "steady",
          instanceType: "m7i.large",
          minNodes: 1,
          maxNodes: 2,
          scaling: { mode: "cluster-autoscaler" },
        },
        {
          name: "burst",
          scaling: { mode: "karpenter", instanceTypes: ["m7i.large"] },
        },
      ],
    });

    const clusterAutoscaler = resourcesOf("k8s.Chart").find(
      ({ name }) => name === "prod-cluster-autoscaler"
    );
    expect(
      (clusterAutoscaler?.args.values as { awsRegion?: { value: string } }).awsRegion?.value
    ).toBe("ca-central-1");
    const karpenter = resourcesOf("k8s.Release").find(({ name }) => name === "prod-karpenter");
    expect(
      (karpenter?.args.values as { controller: { env: Array<{ value: { value: string } }> } })
        .controller.env[0]?.value.value
    ).toBe("ca-central-1");
    const karpenterPolicy = resourcesOf("iam.RolePolicy").find(({ name }) =>
      name.includes("karpenter-controller-policy")
    );
    expect((karpenterPolicy?.args.policy as { value: string }).value).toContain(
      "arn:aws:ec2:ca-central-1:"
    );
  });

  it("supports Karpenter-only capacity and disables Spot interruption resources when requested", () => {
    create(
      { autoscalerControllerNodePoolName: "steady", karpenter: { interruptionHandling: false } },
      network,
      {
        ...config,
        nodePools: [
          {
            name: "steady",
            instanceType: "m7i.large",
            minNodes: 1,
            maxNodes: 2,
            scaling: { mode: "fixed" },
          },
          {
            name: "burst",
            scaling: { mode: "karpenter", instanceTypes: ["m7i.large"], capacityTypes: ["spot"] },
          },
        ],
      }
    );
    expect(resourcesOf("eks.NodeGroup")).toHaveLength(1);
    expect(resourcesOf("autoscaling.Tag")).toHaveLength(0);
    expect(resourcesOf("sqs.Queue")).toHaveLength(0);
    expect(resourcesOf("k8s.Chart").map(({ name }) => name)).not.toContain(
      "prod-cluster-autoscaler"
    );
    expect(resourcesOf("k8s.CustomResource").map(({ args }) => args.kind)).toContain("NodePool");
  });

  it("rejects Karpenter AZs that are not present in Nimbus private subnets", () => {
    expect(() =>
      create({ autoscalerControllerNodePoolName: "steady" }, network, {
        ...config,
        nodePools: [
          { name: "steady", instanceType: "m7i.large", minNodes: 1, maxNodes: 2 },
          {
            name: "burst",
            scaling: {
              mode: "karpenter",
              instanceTypes: ["m7i.large"],
              availabilityZones: ["us-west-2a"],
            },
          },
        ],
      })
    ).toThrow(/outside Nimbus private subnets/);
  });
});
