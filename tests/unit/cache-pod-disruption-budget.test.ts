/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from "vitest";
const releases: any[] = [];
const budgets: any[] = [];
const deployments: any[] = [];
vi.mock("../../src/utils/ensure-namespace", () => ({ ensureNamespace: () => ({}) }));
vi.mock("../../src/nimbus", () => ({ nimbus: { register: () => {} } }));
vi.mock("../../src/observability/alerts", () => ({ createPrometheusRule: () => {} }));
vi.mock("@pulumi/kubernetes", () => {
  class Resource {
    constructor(
      public name: string,
      public args: any,
      public opts: any
    ) {}
  }
  class Release extends Resource {
    status = {
      apply: (fn: (v: any) => any) => ({ apply: (f: any) => f(fn({ name: this.name })) }),
    };
    constructor(n: string, a: any, o: any) {
      super(n, a, o);
      releases.push(this);
    }
  }
  class Pdb extends Resource {
    constructor(n: string, a: any, o: any) {
      super(n, a, o);
      budgets.push(this);
    }
  }
  class Deployment extends Resource {
    constructor(n: string, a: any, o: any) {
      super(n, a, o);
      deployments.push(this);
    }
  }
  class Generic extends Resource {
    data = { apply: (fn: any) => fn({}) };
  }
  return {
    helm: { v3: { Release } },
    policy: { v1: { PodDisruptionBudget: Pdb } },
    apps: { v1: { Deployment } },
    core: {
      v1: {
        Namespace: Generic,
        ConfigMap: Generic,
        Service: Generic,
        Secret: Generic,
        ServiceAccount: Generic,
      },
    },
    rbac: { v1: { Role: Generic, RoleBinding: Generic } },
    apiextensions: { CustomResource: Generic },
  };
});
vi.mock("@pulumi/pulumi", () => ({
  output: (v: any) => ({ apply: (fn: any) => fn(v) }),
  all: (vs: any[]) => ({ apply: (fn: any) => fn(vs) }),
  interpolate: (s: any) => s,
}));
import { createCache } from "../../src/cache/cache";
afterEach(() => {
  releases.length = 0;
  budgets.length = 0;
  deployments.length = 0;
});
describe("cache workload disruption budgets", () => {
  it("maps Redis master and replica availability separately", () => {
    createCache(
      "sessions",
      {
        cloud: "aws",
        engine: "redis",
        mode: "helm",
        architecture: "replication",
        replicas: 3,
        podDisruptionBudget: {},
        scheduling: { replicas: 4, spread: { strategy: "pod-anti-affinity", mode: "required" } },
      } as any,
      {} as any
    );
    const values = releases[0].args.values;
    expect(values.master.pdb).toEqual({ create: true, minAvailable: 1 });
    expect(values.replica.replicaCount).toBe(4);
    expect(values.replica.pdb).toEqual({ create: true, maxUnavailable: 1 });
    expect(
      values.replica.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0]
        .labelSelector.matchLabels
    ).toMatchObject({ "app.kubernetes.io/component": "replica" });
    expect(budgets[0].args.spec).toEqual({
      maxUnavailable: 1,
      selector: { matchLabels: { app: "sessions-master-tracker" } },
    });
  });
  it("adds availability to Nimbus tracker and honors cache opt-out", () => {
    createCache(
      "sessions",
      {
        cloud: "aws",
        engine: "redis",
        mode: "helm",
        architecture: "replication",
        podDisruptionBudget: { enabled: false },
        scheduling: { replicas: 2 },
      } as any,
      {} as any
    );
    expect(deployments[0].args.spec.replicas).toBe(2);
    expect(releases[0].args.values.master.pdb).toEqual({ create: false });
    expect(releases[0].args.values.replica.pdb).toEqual({ create: false });
    expect(budgets).toHaveLength(0);
  });
});
