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
  return {
    allCalls,
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
        readonly endpoint = output("https://eks.example.com");
        readonly certificateAuthority = output({ data: "mock-ca" });
        readonly version = output("1.32");
        constructor(name: string, args: Record<string, unknown>) {
          record("eks.Cluster", name, args);
        }
      },
      NodeGroup: class {
        readonly kind = "eks.NodeGroup";
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
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
    },
  };
});

import { createEksCluster } from "../../src/aws/cluster";

const config = {
  cloud: "aws",
  version: "1.32",
  nodePools: [{ name: "workers", instanceType: "m7i.large", minNodes: 1, maxNodes: 3 }],
} satisfies IClusterConfig;

const network = {
  name: "prod-network",
  cloud: { provider: "aws", region: "us-east-1" },
  vpcId: mockPulumi.output("vpc-123"),
  cidr: "10.0.0.0/16",
  publicSubnetIds: mockPulumi.output(["subnet-public"]),
  privateSubnetIds: mockPulumi.output(["subnet-private"]),
  nativeResource: {} as INetwork["nativeResource"],
} as unknown as INetwork;

const create = (options?: IEksOptions, networkOverride: INetwork = network) =>
  createEksCluster("prod", config, networkOverride, options);

const resourcesOf = (kind: string) => constructed.resources.filter((item) => item.kind === kind);

beforeEach(() => {
  constructed.resources.length = 0;
  mockPulumi.allCalls.length = 0;
});

describe("createEksCluster options", () => {
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
});
