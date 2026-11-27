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
  policy: {
    v1: {
      PodDisruptionBudget: class {
        readonly kind = "k8s.PodDisruptionBudget";
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
          constructed.resources.push({ kind: "k8s.PodDisruptionBudget", name, args, opts });
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

describe("EKS add-on PDB schema boundaries", () => {
  it("maps budgets through each selected Deployment add-on schema and preserves raw values", () => {
    create({
      metricsServer: {
        configurationValues: JSON.stringify({
          replicas: 2,
          resources: { requests: { cpu: "20m" } },
        }),
        configurationSchema: schemaSnapshot(schemaWithPdb, "v0.7.2-eksbuild.1"),
        podDisruptionBudget: { maxUnavailable: 1 },
      },
      communityAddons: {
        certManager: {
          version: "v1.17.2-eksbuild.1",
          configurationSchema: schemaSnapshot(schemaWithPdb, "v1.17.2-eksbuild.1"),
          podDisruptionBudget: { maxUnavailable: 1 },
        },
        kubeStateMetrics: {
          version: "v2.15.0-eksbuild.4",
          configurationSchema: schemaSnapshot(schemaWithPdb, "v2.15.0-eksbuild.4"),
          podDisruptionBudget: { maxUnavailable: 1 },
        },
        prometheusNodeExporter: {
          workloadKind: "Deployment",
          version: "v1.9.1-eksbuild.2",
          configurationSchema: schemaSnapshot(schemaWithPdb, "v1.9.1-eksbuild.2"),
          podDisruptionBudget: { maxUnavailable: 1 },
        },
      },
    });
    const addon = resourcesOf("eks.Addon").find(({ args }) => args.addonName === "metrics-server");
    expect(addon?.args.addonVersion).toBe("v0.7.2-eksbuild.1");
    expect(JSON.parse(String(addon?.args.configurationValues))).toEqual({
      replicas: 2,
      resources: { requests: { cpu: "20m" } },
      podDisruptionBudget: { maxUnavailable: 1 },
    });
    for (const addonName of [
      "metrics-server",
      "cert-manager",
      "kube-state-metrics",
      "prometheus-node-exporter",
    ]) {
      const resource = resourcesOf("eks.Addon").find(({ args }) => args.addonName === addonName);
      expect(JSON.parse(String(resource?.args.configurationValues))).toMatchObject({
        podDisruptionBudget: { maxUnavailable: 1 },
      });
    }
    expect(resourcesOf("k8s.PodDisruptionBudget")).toHaveLength(0);
  });

  it("uses native schema PDB configuration and rejects caller budget conflicts", () => {
    const schema = JSON.stringify({
      type: "object",
      properties: {
        deployment: { $ref: "#/definitions/Deployment" },
      },
      definitions: {
        Deployment: {
          type: "object",
          properties: {
            podDisruptionBudget: {
              type: "object",
              properties: { maxUnavailable: { type: "integer" } },
            },
          },
        },
      },
    });
    create({
      metricsServer: {
        configurationSchema: schemaSnapshot(schema, "v0.7.2-eksbuild.1"),
        podDisruptionBudget: { maxUnavailable: 1 },
        configurationValues: JSON.stringify({ replicas: 2, deployment: {} }),
      },
    });
    const addon = resourcesOf("eks.Addon").find(({ args }) => args.addonName === "metrics-server");
    expect(JSON.parse(String(addon?.args.configurationValues))).toEqual({
      replicas: 2,
      deployment: { podDisruptionBudget: { maxUnavailable: 1 } },
    });
    expect(resourcesOf("k8s.PodDisruptionBudget")).toHaveLength(0);
    expect(() =>
      create({
        metricsServer: {
          configurationSchema: schemaSnapshot(schema, "v0.7.2-eksbuild.1"),
          podDisruptionBudget: { maxUnavailable: 1 },
          configurationValues: JSON.stringify({ podDisruptionBudget: { maxUnavailable: 0 } }),
        },
      })
    ).toThrow(/already configures a PDB/);
  });

  it("excludes DaemonSet node exporter and unrelated DaemonSets", () => {
    create({
      communityAddons: {
        prometheusNodeExporter: {
          configurationSchema: schemaSnapshot(schemaWithoutPdb, "v1.9.1-eksbuild.2"),
          podDisruptionBudget: { maxUnavailable: 1 },
        },
      },
      addons: ["aws-node", "kube-proxy"],
    });
    expect(resourcesOf("k8s.PodDisruptionBudget")).toHaveLength(0);
    expect(resourcesOf("eks.Addon").map(({ args }) => args.addonName)).toEqual(
      expect.arrayContaining(["prometheus-node-exporter", "aws-node", "kube-proxy"])
    );
  });

  it("rejects a missing schema and a schema snapshot for a different selected version", () => {
    expect(() => create({ metricsServer: { podDisruptionBudget: { maxUnavailable: 1 } } })).toThrow(
      /requires the exact configurationSchema/
    );
    expect(() =>
      create({
        metricsServer: {
          addonVersion: "v0.7.3-eksbuild.1",
          configurationSchema: schemaSnapshot(schemaWithoutPdb, "v0.7.2-eksbuild.1"),
          podDisruptionBudget: { maxUnavailable: 1 },
        },
      })
    ).toThrow(/must match the requested add-on version/);
  });

  it("rejects an add-on schema with no native PDB support instead of risking a duplicate", () => {
    expect(() =>
      create({
        metricsServer: {
          addonVersion: "v0.7.2-eksbuild.1",
          configurationSchema: schemaSnapshot(schemaWithoutPdb, "v0.7.2-eksbuild.1"),
          podDisruptionBudget: { maxUnavailable: 1 },
        },
      })
    ).toThrow(/has no native PDB configuration/);
    expect(resourcesOf("eks.Addon").some(({ args }) => args.addonName === "metrics-server")).toBe(
      false
    );
  });
});

const schemaWithoutPdb = JSON.stringify({
  type: "object",
  properties: { replicas: { type: "integer" }, resources: { type: "object" } },
  additionalProperties: false,
});

const schemaWithPdb = JSON.stringify({
  type: "object",
  properties: {
    replicas: { type: "integer" },
    resources: { type: "object" },
    podDisruptionBudget: {
      type: "object",
      properties: {
        minAvailable: { type: "integer" },
        maxUnavailable: { type: "integer" },
      },
    },
  },
});

function schemaSnapshot(schema: string, addonVersion: string) {
  return { schema, addonVersion };
}
