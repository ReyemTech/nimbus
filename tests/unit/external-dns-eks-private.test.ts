/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-extraneous-class */
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => {
  const resources: Array<{ kind: string; name: string; args: any; opts: any }> = [];
  const output = (value: any): any => ({
    value,
    apply: (fn: (value: any) => any) => output(fn(value)),
  });
  const unwrap = (value: any): any =>
    value && typeof value.apply === "function" ? unwrap(value.value) : value;
  return { resources, output, unwrap };
});

vi.mock("@pulumi/pulumi", () => ({
  all: (values: any[]) => fixtures.output(values.map(fixtures.unwrap)),
  output: (value: any) => fixtures.output(fixtures.unwrap(value)),
}));

vi.mock("@pulumi/aws", () => {
  class Cluster {
    name = "prod";
    arn = fixtures.output("arn:aws:eks:ca-central-1:123456789012:cluster/prod");
  }
  class Addon {
    constructor(name: string, args: any, opts: any) {
      fixtures.resources.push({ kind: "addon", name, args, opts });
    }
  }
  class PodIdentityAssociation {
    associationId = fixtures.output("association-id");
    constructor(name: string, args: any, opts: any) {
      fixtures.resources.push({ kind: "identity", name, args, opts });
    }
  }
  class Role {
    arn = fixtures.output("arn:aws:iam::123456789012:role/external-dns");
    id = fixtures.output("external-dns-role");
    constructor(name: string, args: any, opts: any) {
      fixtures.resources.push({ kind: "role", name, args, opts });
    }
  }
  class RolePolicy {
    constructor(name: string, args: any, opts: any) {
      fixtures.resources.push({ kind: "policy", name, args, opts });
    }
  }
  class Zone {
    zoneId = fixtures.output("Z-CREATED");
    constructor(name: string, args: any, opts: any) {
      fixtures.resources.push({ kind: "zone", name, args, opts });
    }
  }
  class ZoneAssociation {
    constructor(name: string, args: any, opts: any) {
      fixtures.resources.push({ kind: "association", name, args, opts });
    }
  }
  return {
    eks: { Cluster, Addon, PodIdentityAssociation },
    iam: { Role, RolePolicy },
    route53: { Zone, ZoneAssociation },
    getCallerIdentityOutput: () => fixtures.output({ accountId: "123456789012" }),
    getPartitionOutput: () => fixtures.output({ partition: "aws" }),
  };
});

vi.mock("@pulumi/kubernetes", () => ({
  core: {
    v1: {
      Namespace: class {
        constructor(name: string, args: any, opts: any) {
          fixtures.resources.push({ kind: "namespace", name, args, opts });
        }
      },
    },
  },
  helm: {
    v3: {
      Release: class {
        constructor(name: string, args: any, opts: any) {
          fixtures.resources.push({ kind: "release", name, args, opts });
        }
      },
    },
  },
}));

vi.mock("../../src/utils/ensure-namespace", () => ({
  ensureNamespace: (name: string) => ({ name, kind: "namespace-reference" }),
}));

import * as aws from "@pulumi/aws";
import { deployEksExternalDnsSplit } from "../../src/platform/components/external-dns-eks";

describe("split EKS Route 53 ExternalDNS", () => {
  beforeEach(() => fixtures.resources.splice(0));

  const deploy = (
    route53: any = {},
    externalDnsValues: Record<string, unknown> = { txtOwnerId: "prod-eks", policy: "upsert-only" }
  ) => {
    const cluster = {
      nativeResource: new aws.eks.Cluster("cluster", {} as any),
      awsVpcId: fixtures.output("vpc-123"),
      awsRegion: "ca-central-1",
      awsResourceTags: { "nimbus:cluster": "ca-central-1/prod" },
      providerResources: { podIdentityAgent: { kind: "existing-pod-identity-agent" } },
    } as any;
    return deployEksExternalDnsSplit(
      "prod",
      cluster,
      "example.com",
      {
        dnsProvider: "route53",
        hostedZoneIds: ["Z-PUBLIC"],
        domainFilters: ["example.com"],
        values: externalDnsValues,
        route53: {
          privateHostedZones: [{ mode: "create", prefix: "cac-1" }],
          ...route53,
        },
      } as any,
      {} as any
    );
  };

  it("creates a prefixed private zone associated with the cluster VPC", () => {
    deploy();
    const zone = fixtures.resources.find((resource) => resource.kind === "zone");
    expect(zone?.args).toMatchObject({
      name: "cac-1.example.com",
      vpcs: [{ vpcRegion: "ca-central-1" }],
      tags: { "nimbus:cluster": "ca-central-1/prod" },
    });
    expect(fixtures.unwrap(zone?.args.vpcs[0].vpcId)).toBe("vpc-123");
  });

  it("defaults the managed private zone prefix to internal", () => {
    deploy({ privateHostedZones: [{ mode: "create" }] }, {});
    expect(fixtures.resources.find((resource) => resource.kind === "zone")?.args.name).toBe(
      "internal.example.com"
    );
  });

  it("rejects duplicate zone names before creating AWS resources", () => {
    expect(() =>
      deploy({
        privateHostedZones: [
          { mode: "create", prefix: "cac-1" },
          { mode: "create", prefix: "cac-1" },
        ],
      })
    ).toThrow(/unique domain filters/);
    expect(fixtures.resources.some((resource) => resource.kind === "zone")).toBe(false);
  });

  it("creates public Ingress, private Ingress, and public service controllers", () => {
    deploy();
    const releases = fixtures.resources.filter((resource) => resource.kind === "release");
    expect(releases).toHaveLength(3);

    const valuesByName = Object.fromEntries(
      releases.map((release) => {
        const values = release.args.values;
        return [
          release.name,
          {
            ...values,
            extraArgs: {
              ...values.extraArgs,
              "zone-id-filter": fixtures.unwrap(values.extraArgs["zone-id-filter"]),
            },
          },
        ];
      })
    );
    const publicIngress = valuesByName["prod-external-dns-public-ingress"];
    const privateIngress = valuesByName["prod-external-dns-private-ingress"];
    const services = valuesByName["prod-external-dns-public-services"];
    expect(publicIngress).toMatchObject({
      sources: ["ingress"],
      annotationFilter: "nimbus.dev/dns-visibility!=private",
      domainFilters: ["example.com"],
      policy: "upsert-only",
      env: [{ name: "AWS_REGION", value: "ca-central-1" }],
      extraArgs: { "aws-zone-type": "public", "zone-id-filter": ["/hostedzone/Z-PUBLIC"] },
    });
    expect(privateIngress).toMatchObject({
      sources: ["ingress"],
      annotationFilter: "nimbus.dev/dns-visibility=private",
      domainFilters: ["cac-1.example.com"],
      policy: "upsert-only",
      extraArgs: { "aws-zone-type": "private", "zone-id-filter": ["/hostedzone/Z-CREATED"] },
    });
    expect(services).toMatchObject({ sources: ["service", "traefik-proxy"] });
    expect(new Set(releases.map((release) => release.args.values.txtOwnerId)).size).toBe(3);
    expect(new Set(releases.map((release) => release.args.values.extraArgs.controller)).size).toBe(
      3
    );
    expect(releases.map((release) => release.args.values.serviceAccount.name)).toEqual([
      "external-dns-public-ingress",
      "external-dns-private-ingress",
      "external-dns-public-services",
    ]);
  });

  it("retains the legacy default TXT owner for public records during split migration", () => {
    deploy({ privateHostedZones: [{ mode: "create" }] }, {});
    const publicRelease = fixtures.resources.find(
      (resource) =>
        resource.kind === "release" && resource.name === "prod-external-dns-public-ingress"
    );
    expect(publicRelease?.args.values.txtOwnerId).toBe("default");
  });

  it("associates an existing zone only when requested", () => {
    deploy({
      privateHostedZones: [
        {
          mode: "existing",
          hostedZoneId: "Z-EXISTING",
          domainFilter: "internal.example.com",
          associateClusterVpc: true,
        },
      ],
    });
    const association = fixtures.resources.find((resource) => resource.kind === "association");
    expect(association?.args).toMatchObject({
      zoneId: "Z-EXISTING",
      vpcRegion: "ca-central-1",
    });
    expect(fixtures.unwrap(association?.args.vpcId)).toBe("vpc-123");
    expect(fixtures.resources.some((resource) => resource.kind === "zone")).toBe(false);
  });

  it("keeps IAM record writes scoped to the corresponding public or private zones", () => {
    deploy();
    const policies = fixtures.resources.filter((resource) => resource.kind === "policy");
    const changes = policies.map((policy) => {
      const statement = JSON.parse(fixtures.unwrap(policy.args.policy)).Statement.find(
        (item: any) => item.Action.includes("route53:ChangeResourceRecordSets")
      );
      return statement.Resource;
    });
    expect(changes).toContainEqual(["arn:aws:route53:::hostedzone/Z-PUBLIC"]);
    expect(changes).toContainEqual(["arn:aws:route53:::hostedzone/Z-CREATED"]);
    expect(changes.every((zones) => !zones.includes("*") && zones.length === 1)).toBe(true);
  });
});
