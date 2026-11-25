/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-extraneous-class, @typescript-eslint/no-non-null-assertion */
import { describe, expect, it, vi, beforeEach } from "vitest";

const records: Array<{ kind: string; name: string; args: any; opts: any }> = [];
const output = (value: any): any => ({ apply: (fn: (arg: any) => any) => fn(value) });
const unwrap = (value: any): any =>
  value && typeof value.apply === "function" ? unwrap(value.apply((v: any) => v)) : value;

vi.mock("@pulumi/pulumi", () => ({
  all: (values: any[]) => output(values.map(unwrap)),
  output: (value: any) => output(unwrap(value)),
}));

vi.mock("@pulumi/aws", () => {
  class EksCluster {
    name = "cluster";
    arn = "cluster-arn";
  }
  class Addon {
    constructor(name: string, args: any, opts: any) {
      records.push({ kind: "addon", name, args, opts });
    }
  }
  class PodIdentityAssociation {
    constructor(name: string, args: any, opts: any) {
      records.push({ kind: "identity", name, args, opts });
    }
  }
  class Role {
    arn = "role-arn";
    id = "role-id";
    constructor(name: string, args: any, opts: any) {
      records.push({ kind: "role", name, args, opts });
    }
  }
  class RolePolicy {
    constructor(name: string, args: any, opts: any) {
      records.push({ kind: "policy", name, args, opts });
    }
  }
  return {
    eks: { Cluster: EksCluster, Addon, PodIdentityAssociation },
    iam: { Role, RolePolicy },
    getPartitionOutput: () => output({ partition: "aws" }),
    getCallerIdentityOutput: () => output({ accountId: "123456789012" }),
    route53: { getZoneOutput: () => output({ zoneId: "Z-ONE" }) },
  };
});

import { deployEksExternalDns } from "../../src/platform/components/external-dns-eks";
import { eks } from "@pulumi/aws";

describe("EKS ExternalDNS add-on", () => {
  beforeEach(() => records.splice(0));

  it("applies cluster tags to its AWS-created IAM and EKS resources", () => {
    const awsResourceTags = {
      environment: "production",
      "nimbus:cluster": "ca-central-1/prod",
    };
    const cluster = {
      nativeResource: new eks.Cluster("test", { roleArn: "test", vpcConfig: { subnetIds: [] } }),
      providerResources: {},
      awsResourceTags,
    } as any;

    deployEksExternalDns("prod", cluster, {
      dnsProvider: "route53",
      hostedZoneIds: ["Z123"],
    });

    expect(records.find((resource) => resource.kind === "role")?.args.tags).toEqual(
      awsResourceTags
    );
    expect(
      records.filter((resource) => resource.kind === "addon").map((resource) => resource.args.tags)
    ).toEqual([awsResourceTags, awsResourceTags]);
    expect(records.find((resource) => resource.kind === "identity")?.args.tags).toEqual(
      awsResourceTags
    );
  });

  it("uses the community add-on with Pod Identity and explicit zone scope", () => {
    const cluster = {
      nativeResource: new eks.Cluster("test", { roleArn: "test", vpcConfig: { subnetIds: [] } }),
      providerResources: {},
    } as any;
    const result = deployEksExternalDns("prod", cluster, {
      dnsProvider: "route53",
      hostedZoneIds: ["Z123"],
      domainFilters: ["example.com"],
      addonVersion: "v1.0.0-eksbuild.1",
      values: {
        policy: "upsert",
        txtOwnerId: "prod-cluster",
        zoneIdFilters: ["UNAUTHORIZED"],
      },
    });
    const addon = records.find((r) => r.kind === "addon" && r.args.addonName === "external-dns")!;
    expect(addon.args.addonName).toBe("external-dns");
    expect(addon.args.addonVersion).toBe("v1.0.0-eksbuild.1");
    expect(addon.args.podIdentityAssociations[0].roleArn).toBe("role-arn");
    expect(addon.args.podIdentityAssociations[0].serviceAccount).toBe("external-dns");
    const configuration = JSON.parse(unwrap(addon.args.configurationValues));
    expect(configuration).toMatchObject({
      domainFilters: ["example.com"],
      policy: "upsert",
      registry: "txt",
      txtOwnerId: "prod-cluster",
      sources: ["ingress", "service", "traefik-proxy"],
    });
    expect(configuration).not.toHaveProperty("zoneIdFilters");
    const policy = records.find((r) => r.kind === "policy")!;
    const policyText = unwrap(policy.args.policy);
    const policyStatements = JSON.parse(policyText).Statement;
    expect(
      policyStatements.find((statement: any) =>
        statement.Action.includes("route53:ChangeResourceRecordSets")
      ).Resource
    ).toEqual(["arn:aws:route53:::hostedzone/Z123"]);
    expect(
      policyStatements.find((statement: any) =>
        statement.Action.includes("route53:ListResourceRecordSets")
      ).Resource
    ).toBe("*");
    expect(policyText).not.toContain("AmazonRoute53FullAccess");
    expect(result.certManagerIdentity).toBeDefined();
  });

  it("requires an explicit zone ID or domain filter", () => {
    expect(() =>
      deployEksExternalDns(
        "prod",
        {
          nativeResource: new eks.Cluster("test", {
            roleArn: "test",
            vpcConfig: { subnetIds: [] },
          }),
        } as any,
        {
          dnsProvider: "route53",
        }
      )
    ).toThrow(/hostedZoneIds or non-empty domainFilters/);
  });

  it("resolves domain filters into a zone-scoped policy when IDs are omitted", () => {
    const cluster = {
      nativeResource: new eks.Cluster("test", { roleArn: "test", vpcConfig: { subnetIds: [] } }),
      providerResources: {},
    } as any;
    deployEksExternalDns("prod", cluster, {
      dnsProvider: "route53",
      domainFilters: ["example.com"],
    });
    const policy = records.find((r) => r.kind === "policy");
    const addon = records.find((r) => r.kind === "addon" && r.args.addonName === "external-dns");
    expect(policy).toBeDefined();
    if (!policy) throw new Error("Route 53 IAM policy was not created");
    expect(JSON.parse(unwrap(policy.args.policy)).Statement[0].Resource).toEqual([
      "arn:aws:route53:::hostedzone/Z-ONE",
    ]);
    if (!addon) throw new Error("ExternalDNS add-on was not created");
    expect(JSON.parse(unwrap(addon.args.configurationValues))).toMatchObject({
      domainFilters: ["example.com"],
    });
    expect(JSON.parse(unwrap(addon.args.configurationValues))).not.toHaveProperty("zoneIdFilters");
  });
});
