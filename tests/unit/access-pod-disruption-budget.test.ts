/* eslint-disable @typescript-eslint/no-explicit-any */
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
    budgets.length = 0;
    deployAccessDns(
      "off",
      "iad",
      { enabled: true, podDisruptionBudget: { enabled: false } },
      "access",
      provider,
      []
    );
    expect(budgets).toHaveLength(0);
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
    expect(budgets.map((x) => x.args.metadata.name)).toEqual(["tailscale-operator"]);
    expect(budgets[0].opts.dependsOn).toContain(releases[0]);
    expect(budgets[0].args.spec.selector.matchLabels).toEqual({ app: "operator" });
    expect(releases[1].args.values.disruptionBudget).toEqual({ enabled: true, minAvailable: 2 });
    expect(budgets).toHaveLength(1);
  });
  it("maps WireGuard replicas and rejects unsupported controller spread", () => {
    deployWireGuard("w", {
      cluster: { provider } as any,
      provider: "wireguard",
      wireguard: {
        endpoint: "vpn.example.com",
        serverCidr: "10.0.0.0/24",
        routes: [],
        peers: [],
        scheduling: { replicas: 2 },
        podDisruptionBudget: {},
      },
    });
    expect(releases.at(0)?.args.values.replicaCount).toBe(2);
    expect(releases.at(0)?.args.values.autoscaling).toEqual({ enabled: false });
    expect(releases.at(0)?.args.values.disruptionBudget).toEqual({
      enabled: true,
      minAvailable: 1,
    });
    expect(budgets).toHaveLength(0);
    expect(() =>
      deployWireGuard("conflict", {
        cluster: { provider } as any,
        provider: "wireguard",
        wireguard: {
          endpoint: "vpn.example.com",
          serverCidr: "10.0.0.0/24",
          routes: [],
          peers: [],
          scheduling: { replicas: 2 },
          values: { replicaCount: 3 },
        },
      })
    ).toThrow(/scheduling.replicas conflicts with Helm values.replicaCount/);
    expect(() =>
      deployWireGuard("x", {
        cluster: { provider } as any,
        provider: "wireguard",
        wireguard: {
          endpoint: "vpn.example.com",
          serverCidr: "10.0.0.0/24",
          routes: [],
          peers: [],
          scheduling: { spread: { strategy: "topology-spread" } },
        },
      })
    ).toThrow(/scheduling.spread is not supported/);
  });
  it("rejects WireGuard autoscaling and DaemonSet replica/PDB ambiguity", () => {
    const base = { cluster: { provider } as any, provider: "wireguard" as const };
    expect(() =>
      deployWireGuard("autoscaled", {
        ...base,
        wireguard: {
          endpoint: "vpn.example.com",
          serverCidr: "10.0.0.0/24",
          routes: [],
          peers: [],
          scheduling: { replicas: 2 },
          values: { autoscaling: { enabled: true } },
        },
      })
    ).toThrow(/scheduling.replicas conflicts with Helm values.autoscaling.enabled/);
    expect(() =>
      deployWireGuard("daemonset", {
        ...base,
        wireguard: {
          endpoint: "vpn.example.com",
          serverCidr: "10.0.0.0/24",
          routes: [],
          peers: [],
          scheduling: { replicas: 2 },
          values: { daemonSet: true },
        },
      })
    ).toThrow(/scheduling.replicas is not supported with daemonSet/);
    expect(() =>
      deployWireGuard("daemonset-pdb", {
        ...base,
        wireguard: {
          endpoint: "vpn.example.com",
          serverCidr: "10.0.0.0/24",
          routes: [],
          peers: [],
          podDisruptionBudget: {} as any,
          values: { daemonSet: true },
        },
      })
    ).toThrow(/podDisruptionBudget is not supported with daemonSet/);
  });
  it("maps WireGuard typed PDB to the native chart budget and rejects conflicts", () => {
    deployWireGuard("native", {
      cluster: { provider } as any,
      provider: "wireguard",
      wireguard: {
        endpoint: "vpn.example.com",
        serverCidr: "10.0.0.0/24",
        routes: [],
        peers: [],
        podDisruptionBudget: { minAvailable: 2 },
        values: { autoscaling: { enabled: false } },
      },
    });
    expect(releases.at(0)?.args.values.disruptionBudget).toEqual({
      enabled: true,
      minAvailable: 2,
    });
    expect(budgets).toHaveLength(0);
    expect(() =>
      deployWireGuard("conflict", {
        cluster: { provider } as any,
        provider: "wireguard",
        wireguard: {
          endpoint: "vpn.example.com",
          serverCidr: "10.0.0.0/24",
          routes: [],
          peers: [],
          podDisruptionBudget: { minAvailable: 2 },
          values: { disruptionBudget: { enabled: false } },
        },
      })
    ).toThrow(/podDisruptionBudget conflicts with Helm values.disruptionBudget/);
    expect(() =>
      deployWireGuard("max", {
        cluster: { provider } as any,
        provider: "wireguard",
        wireguard: {
          endpoint: "vpn.example.com",
          serverCidr: "10.0.0.0/24",
          routes: [],
          peers: [],
          podDisruptionBudget: { maxUnavailable: 1 },
          values: { autoscaling: { enabled: false }, replicaCount: 3 },
        },
      })
    ).toThrow(/disruptionBudget supports minAvailable only/);
    expect(() =>
      deployWireGuard("percent", {
        cluster: { provider } as any,
        provider: "wireguard",
        wireguard: {
          endpoint: "vpn.example.com",
          serverCidr: "10.0.0.0/24",
          routes: [],
          peers: [],
          podDisruptionBudget: { minAvailable: "50%" },
          values: { autoscaling: { enabled: false } },
        },
      })
    ).toThrow(/minAvailable supports integer values only/);
  });
  it("rejects Tailscale scheduling because its chart fixes one replica and has no spread values", () => {
    expect(() =>
      deployTailscale("t", {
        cluster: { provider } as any,
        provider: "tailscale",
        tailscale: {
          oauthClientId: "id",
          oauthClientSecret: "secret",
          routes: [],
          scheduling: { replicas: 2 },
        },
      })
    ).toThrow(/scheduling is not supported/);
    expect(releases).toHaveLength(0);
  });
  it("honors controller PDB opt-out", () => {
    deployWireGuard("w", {
      cluster: { provider } as any,
      provider: "wireguard",
      wireguard: {
        endpoint: "vpn.example.com",
        serverCidr: "10.0.0.0/24",
        routes: [],
        peers: [],
        podDisruptionBudget: { enabled: false },
      },
    });
    expect(budgets).toHaveLength(0);
    expect(releases.at(0)?.args.values.disruptionBudget).toEqual({ enabled: false });
  });
  it("derives Tailscale selector from chart fullname overrides", () => {
    deployTailscale("custom", {
      cluster: { provider } as any,
      provider: "tailscale",
      tailscale: {
        oauthClientId: "id",
        oauthClientSecret: "secret",
        routes: [],
        podDisruptionBudget: {},
        values: { nameOverride: "operator-custom" },
      },
    });
    expect(budgets.at(0)?.args.spec.selector.matchLabels).toEqual({
      app: "custom-tailscale-operator-operator-custom",
    });
    deployTailscale("full", {
      cluster: { provider } as any,
      provider: "tailscale",
      tailscale: {
        oauthClientId: "id",
        oauthClientSecret: "secret",
        routes: [],
        podDisruptionBudget: {},
        values: { fullnameOverride: "fixed-operator" },
      },
    });
    expect(budgets.at(1)?.args.spec.selector.matchLabels).toEqual({ app: "fixed-operator" });
    deployTailscale("contains", {
      cluster: { provider } as any,
      provider: "tailscale",
      tailscale: {
        oauthClientId: "id",
        oauthClientSecret: "secret",
        routes: [],
        podDisruptionBudget: {},
        values: { nameOverride: "operator" },
      },
    });
    expect(budgets.at(2)?.args.spec.selector.matchLabels).toEqual({
      app: "contains-tailscale-operator",
    });
  });
});
