import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IClusterConfig } from "../../src/cluster";
import type { INetwork } from "../../src/network";
import type { IEksOptions } from "../../src/aws/cluster";

/* eslint-disable @typescript-eslint/no-extraneous-class -- Pulumi resources are represented by constructor mocks. */

const mockPulumi = vi.hoisted(() => {
  const output = (
    value: unknown
  ): { __mockOutput: true; value: unknown; apply: (fn: (v: unknown) => unknown) => unknown } => ({
    __mockOutput: true,
    value,
    apply: (fn) => output(fn(value)),
  });

  return {
    output,
    all: (values: ReadonlyArray<unknown>) =>
      output(
        values.map((value) =>
          typeof value === "object" && value !== null && "__mockOutput" in value
            ? (value as unknown as { value: unknown }).value
            : value
        )
      ),
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
    constructor(name: string, args: Record<string, unknown>) {
      constructed.resources.push({ kind: "k8s.Provider", name, args });
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
        readonly name = output("prod");
        readonly endpoint = output("https://eks.example.com");
        readonly certificateAuthority = output({ data: "mock-ca" });
        readonly version = output("1.32");
        constructor(name: string, args: Record<string, unknown>) {
          record("eks.Cluster", name, args);
        }
      },
      NodeGroup: class {
        constructor(name: string, args: Record<string, unknown>) {
          record("eks.NodeGroup", name, args);
        }
      },
      Addon: class {
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
          record("eks.Addon", name, args, opts);
        }
      },
      AccessEntry: class {
        constructor(name: string, args: Record<string, unknown>) {
          record("eks.AccessEntry", name, args);
        }
      },
      AccessPolicyAssociation: class {
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

const create = (options?: IEksOptions) => createEksCluster("prod", config, network, options);

const resourcesOf = (kind: string) => constructed.resources.filter((item) => item.kind === kind);

beforeEach(() => {
  constructed.resources.length = 0;
});

describe("createEksCluster options", () => {
  it("preserves defaults when the new options are omitted", () => {
    create();

    expect(resourcesOf("eks.Cluster")[0]?.args.vpcConfig).toMatchObject({
      endpointPublicAccess: true,
      endpointPrivateAccess: true,
      publicAccessCidrs: undefined,
    });
    expect(resourcesOf("eks.Addon").map(({ args }) => args.addonName)).toEqual([
      "vpc-cni",
      "coredns",
      "kube-proxy",
    ]);
    expect(resourcesOf("eks.NodeGroup")[0]?.args.launchTemplate).toBeUndefined();
    expect(resourcesOf("eks.AccessEntry")).toHaveLength(0);
    expect(resourcesOf("ec2.LaunchTemplate")).toHaveLength(0);
    expect(resourcesOf("iam.Role")).toHaveLength(2); // cluster and node roles
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
      dependsOn: [expect.objectContaining({})],
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
      "arn:aws:iam::aws:policy/service-role/AmazonEBSCSIDriverPolicyV2"
    );
    expect(
      resourcesOf("iam.Role").find(({ name }) => name === "prod-ebs-csi-role")?.args
    ).toMatchObject({
      assumeRolePolicy: expect.stringContaining('"pods.eks.amazonaws.com"'),
    });
  });

  it("rejects managed-node-group root disks in Auto Mode", () => {
    expect(() => create({ autoMode: true, nodeGroupRootDisk: { sizeGiB: 80 } })).toThrow(
      /only to EKS managed node groups/
    );
  });
});
