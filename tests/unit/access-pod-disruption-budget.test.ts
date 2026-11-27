/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-extraneous-class */
import { afterEach, describe, expect, it, vi } from "vitest";

const deployments: any[] = [];
const budgets: any[] = [];
const releases: any[] = [];
vi.mock("../../src/utils/ensure-namespace", () => ({ ensureNamespace: () => ({}) }));
vi.mock("@pulumi/kubernetes", () => {
  class Resource {
    constructor(
      public name: string,
      public args: any,
      public opts: any
    ) {}
  }
  class Release extends Resource {
    constructor(name: string, args: any, opts: any) {
      super(name, args, opts);
      releases.push(this);
    }
  }
  class Deployment extends Resource {
    constructor(name: string, args: any, opts: any) {
      super(name, args, opts);
      deployments.push(this);
    }
  }
  class PodDisruptionBudget extends Resource {
    constructor(name: string, args: any, opts: any) {
      super(name, args, opts);
      budgets.push(this);
    }
  }
  class Generic extends Resource {
    spec: any = { clusterIP: "10.0.0.1" };
  }
  return {
    helm: { v3: { Release } },
    apps: { v1: { Deployment } },
    policy: { v1: { PodDisruptionBudget } },
    core: {
      v1: { ConfigMap: Generic, Service: Generic, Namespace: Generic, ServicePatch: Generic },
    },
    apiextensions: { CustomResource: Generic },
  };
});
import { deployAccessDns } from "../../src/access/dns";
import { deployAccessProxy } from "../../src/access/proxy";
import { deployTailscale } from "../../src/access/tailscale";
import { deployWireGuard } from "../../src/access/wireguard";

afterEach(() => {
  deployments.length = 0;
  budgets.length = 0;
  releases.length = 0;
});

describe("access workload availability resources", () => {
  const provider = {} as any;
  it("creates an exact DNS PDB and applies requested replicas", () => {
    deployAccessDns(
      "t",
      "iad",
      { enabled: true, podDisruptionBudget: {}, scheduling: { replicas: 2 } },
      "access",
      provider,
      []
    );
    expect(deployments[0].args.spec.replicas).toBe(2);
    expect(budgets[0].args.spec).toEqual({
      maxUnavailable: 1,
      selector: { matchLabels: { app: "access-dns", "app.kubernetes.io/managed-by": "nimbus" } },
    });
    expect(budgets[0].opts.dependsOn).toContain(deployments[0]);
  });
  it("keeps DNS and proxy budgets separate and honors opt-out", () => {
    const dnsConfig = { enabled: true, podDisruptionBudget: {}, scheduling: { replicas: 2 } };
    deployAccessDns("t", "iad", dnsConfig, "access", provider, []);
    deployAccessProxy("t", [], "iad.internal", "access", provider, [], dnsConfig);
    expect(budgets.map((x) => x.args.spec.selector.matchLabels.app)).toEqual([
      "access-dns",
      "access-proxy",
    ]);
  });
  it("creates controller budgets after their Helm releases", () => {
    deployTailscale("t", {
      cluster: { provider } as any,
      provider: "tailscale",
      tailscale: {
        oauthClientId: "id",
        oauthClientSecret: "secret",
        routes: [],
        podDisruptionBudget: {},
      },
    });
    deployWireGuard("w", {
      cluster: { provider } as any,
      provider: "wireguard",
      wireguard: {
        endpoint: "vpn.example.com",
        serverCidr: "10.0.0.0/24",
        routes: [],
        peers: [],
        podDisruptionBudget: {},
      },
    });
    expect(budgets.map((x) => x.args.metadata.name)).toEqual(["tailscale-operator", "wireguard"]);
    expect(budgets[0].opts.dependsOn).toContain(releases[0]);
    expect(budgets[1].opts.dependsOn).toContain(releases[1]);
  });
});
