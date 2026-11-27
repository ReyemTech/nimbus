import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as PulumiModule from "@pulumi/pulumi";
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

const mockAwsConfig = vi.hoisted(() => ({ region: undefined as string | undefined }));

vi.mock("@pulumi/pulumi", async (importOriginal) => ({
  ...(await importOriginal<typeof PulumiModule>()),
  ...mockPulumi,
}));

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
    config: mockAwsConfig,
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
      Tag: class {
        readonly kind = "ec2.Tag";
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
          record("ec2.Tag", name, args, opts);
        }
      },
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
  mockAwsConfig.region = undefined;
  mockPulumi.allCalls.length = 0;
  mockPulumi.clusterArn.value = "arn:aws:eks:us-east-1:123456789012:cluster/prod";
  mockPulumi.clusterIssuer.value = "https://oidc.eks.us-east-1.amazonaws.com/id/EXAMPLE";
});

describe("EKS autoscaler disruption settings", () => {
  it("protects the one-replica Cluster Autoscaler and Karpenter controllers by default", () => {
    create({ autoscalerControllerNodePoolName: "steady" }, network, {
      ...config,
      nodePools: [
        {
          name: "steady",
          instanceType: "m7i.large",
          minNodes: 1,
          maxNodes: 3,
          scaling: { mode: "cluster-autoscaler" },
        },
        { name: "burst", scaling: { mode: "karpenter", instanceTypes: ["m7i.large"] } },
      ],
    });
    const ca = resourcesOf("k8s.Chart").find(({ name }) => name === "prod-cluster-autoscaler");
    const kp = resourcesOf("k8s.Release").find(({ name }) => name === "prod-karpenter");
    expect(object(ca?.args.values).podDisruptionBudget).toEqual({
      enabled: true,
      minAvailable: 1,
    });
    expect(object(kp?.args.values).podDisruptionBudget).toMatchObject({ maxUnavailable: 0 });
  });

  it("honors controller PDB opt-out and scopes placement selectors to controller pods", () => {
    create(
      {
        autoscalerControllerNodePoolName: "steady",
        clusterAutoscaler: {
          podDisruptionBudget: { enabled: false },
          scheduling: { spread: { strategy: "topology-spread" } },
        },
        karpenter: {
          podDisruptionBudget: { enabled: false },
          scheduling: { spread: { strategy: "topology-spread" } },
        },
      },
      network,
      {
        ...config,
        nodePools: [
          {
            name: "steady",
            instanceType: "m7i.large",
            minNodes: 1,
            maxNodes: 3,
            scaling: { mode: "cluster-autoscaler" },
          },
          { name: "burst", scaling: { mode: "karpenter", instanceTypes: ["m7i.large"] } },
        ],
      }
    );
    const ca = resourcesOf("k8s.Chart").find(({ name }) => name === "prod-cluster-autoscaler");
    const kp = resourcesOf("k8s.Release").find(({ name }) => name === "prod-karpenter");
    const caValues = object(ca?.args.values);
    const kpValues = object(kp?.args.values);
    expect(caValues.podDisruptionBudget).toEqual({ enabled: false });
    expect(
      object(object(array(caValues.topologySpreadConstraints)[0]).labelSelector).matchLabels
    ).toEqual({
      "app.kubernetes.io/name": "cluster-autoscaler",
      "app.kubernetes.io/instance": "prod-cluster-autoscaler",
    });
    expect(object(kpValues.podDisruptionBudget).maxUnavailable).toBe(1);
    expect(
      object(object(array(kpValues.topologySpreadConstraints)[0]).labelSelector).matchLabels
    ).toEqual({
      "app.kubernetes.io/name": "karpenter",
      "app.kubernetes.io/instance": "prod-karpenter",
    });
  });
});

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
