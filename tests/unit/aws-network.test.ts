import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPulumi = vi.hoisted(() => {
  const output = (value: unknown) => ({
    __mockOutput: true,
    value,
    apply: (fn: (value: unknown) => unknown) => output(fn(value)),
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
  natRouteState: "active",
}));

const mockAwsConfig = vi.hoisted(() => ({ region: undefined as string | undefined }));

vi.mock("@pulumi/pulumi", () => mockPulumi);

vi.mock("@pulumi/aws", () => {
  const record = (kind: string, name: string, args: Record<string, unknown>, opts?: unknown) => {
    constructed.resources.push({ kind, name, args, opts });
  };
  const output = mockPulumi.output;
  return {
    config: mockAwsConfig,
    getAvailabilityZonesOutput: vi.fn(() => ({
      names: output(["ca-central-1a", "ca-central-1b"]),
    })),
    ec2: {
      Vpc: class {
        readonly id = output("vpc-123");
        constructor(name: string, args: Record<string, unknown>) {
          record("ec2.Vpc", name, args);
        }
      },
      InternetGateway: class {
        readonly id = output("igw-123");
        constructor(name: string, args: Record<string, unknown>) {
          record("ec2.InternetGateway", name, args);
        }
      },
      Subnet: class {
        readonly id = output("subnet-123");
        constructor(name: string, args: Record<string, unknown>) {
          record("ec2.Subnet", name, args);
        }
      },
      RouteTable: class {
        readonly id = output("rtb-123");
        constructor(name: string, args: Record<string, unknown>) {
          record("ec2.RouteTable", name, args);
        }
      },
      RouteTableAssociation: class {
        readonly id = output("rtb-assoc-123");
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
          record("ec2.RouteTableAssociation", name, args, opts);
        }
      },
      Route: class {
        readonly state = output(constructed.natRouteState);
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
          record("ec2.Route", name, args, opts);
        }
      },
      SecurityGroup: class {
        readonly id = output("sg-nat");
        constructor(name: string, args: Record<string, unknown>) {
          record("ec2.SecurityGroup", name, args);
        }
      },
      NetworkInterface: class {
        readonly id = output("eni-nat");
        constructor(name: string, args: Record<string, unknown>) {
          record("ec2.NetworkInterface", name, args);
        }
      },
      Eip: class {
        readonly id = output("eipalloc-123");
        constructor(name: string, args: Record<string, unknown>) {
          record("ec2.Eip", name, args);
        }
      },
      LaunchTemplate: class {
        readonly id = output("lt-nat");
        constructor(name: string, args: Record<string, unknown>) {
          record("ec2.LaunchTemplate", name, args);
        }
      },
      NatGateway: class {
        readonly id = output("nat-123");
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
          record("ec2.NatGateway", name, args, opts);
        }
      },
      getAmiOutput: vi.fn(() => ({ id: output("ami-fcknat") })),
    },
    iam: {
      Role: class {
        readonly name = output("nat-role");
        constructor(name: string, args: Record<string, unknown>) {
          record("iam.Role", name, args);
        }
      },
      InstanceProfile: class {
        readonly name = output("nat-profile");
        constructor(name: string, args: Record<string, unknown>) {
          record("iam.InstanceProfile", name, args);
        }
      },
    },
    autoscaling: {
      Group: class {
        readonly id = output("asg-nat");
        constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
          record("autoscaling.Group", name, args, opts);
        }
      },
    },
  };
});

import { createAwsNetwork } from "../../src/aws/network";

beforeEach(() => {
  constructed.resources.length = 0;
  constructed.natRouteState = "active";
  mockAwsConfig.region = undefined;
});

describe("createAwsNetwork NAT readiness", () => {
  it("adds the cluster identifier to dedicated network resources only when requested", () => {
    mockAwsConfig.region = "ca-central-1";
    createAwsNetwork("prod", {
      cloud: "aws",
      cidr: "10.0.0.0/16",
      natStrategy: "fck-nat",
      tags: { environment: "production" },
      clusterNameForTags: "prod-eks",
    });

    const taggedResources = constructed.resources.filter(({ args }) => args.tags !== undefined);
    expect(taggedResources.length).toBeGreaterThan(0);
    expect(
      taggedResources.every(({ args }) => {
        const resourceTags = args.tags;
        return Array.isArray(resourceTags)
          ? resourceTags.some(
              (tag) =>
                (tag as { key?: string; value?: string }).key === "nimbus:cluster" &&
                (tag as { key?: string; value?: string }).value === "ca-central-1/prod-eks"
            )
          : (resourceTags as Record<string, string>)?.["nimbus:cluster"] ===
              "ca-central-1/prod-eks";
      })
    ).toBe(true);
    expect(taggedResources[0]?.args.tags).toMatchObject({ environment: "production" });
  });

  it("does not apply the cluster identifier to shared networks by default", () => {
    createAwsNetwork("shared", {
      cloud: { provider: "aws", region: "ca-central-1" },
      cidr: "10.0.0.0/16",
      natStrategy: "none",
      tags: { environment: "shared" },
    });

    expect(
      constructed.resources
        .filter(({ args }) => args.tags !== undefined)
        .every(({ args }) => !(args.tags as Record<string, string>)?.["nimbus:cluster"])
    ).toBe(true);
  });

  it("waits for fck-nat capacity and an active default route before exposing private subnets", () => {
    const network = createAwsNetwork("prod", {
      cloud: "aws",
      cidr: "10.0.0.0/16",
      natStrategy: "fck-nat",
    });

    const asg = constructed.resources.find(({ kind }) => kind === "autoscaling.Group");
    const route = constructed.resources.find(
      ({ kind, args }) => kind === "ec2.Route" && args.networkInterfaceId !== undefined
    );
    expect(asg?.args).toMatchObject({ waitForCapacityTimeout: "15m" });
    expect((route?.opts as { dependsOn?: unknown[] } | undefined)?.dependsOn).toHaveLength(1);
    expect((network.natReady as unknown as { value: boolean }).value).toBe(true);
  });

  it("does not report fck-nat ready when the default route is blackholed", () => {
    constructed.natRouteState = "blackhole";

    expect(() =>
      createAwsNetwork("prod", {
        cloud: "aws",
        cidr: "10.0.0.0/16",
        natStrategy: "fck-nat",
      })
    ).toThrow(/fck-nat default route.*blackhole/);
  });

  it("reports managed NAT ready only after its default route is active", () => {
    const network = createAwsNetwork("prod", {
      cloud: "aws",
      cidr: "10.0.0.0/16",
      natStrategy: "managed",
    });

    const route = constructed.resources.find(
      ({ kind, args }) => kind === "ec2.Route" && args.natGatewayId !== undefined
    );
    expect(route?.args.destinationCidrBlock).toBe("0.0.0.0/0");
    expect((network.natReady as unknown as { value: boolean }).value).toBe(true);
  });
});
