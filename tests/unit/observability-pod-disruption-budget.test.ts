/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, describe, expect, it, vi } from "vitest";
const { output } = vi.hoisted(() => {
  const output: any = (v: any): any => ({ apply: (fn: any) => output(fn(v)) });
  return { output };
});
const releases: any[] = [];
const budgets: any[] = [];
const deployments: any[] = [];
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
    status: any;
    constructor(n: string, a: any, o: any) {
      super(n, a, o);
      this.status = output({ name: this.name });
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
    spec: any = { clusterIP: "10.0.0.1" };
  }
  return {
    helm: { v3: { Release } },
    policy: { v1: { PodDisruptionBudget: Pdb } },
    apps: { v1: { Deployment } },
    core: {
      v1: {
        Namespace: Generic,
        ConfigMap: Generic,
        Secret: Generic,
        Service: Generic,
        ServiceAccount: Generic,
      },
    },
    apiextensions: { CustomResource: Generic },
    rbac: {
      v1: {
        ClusterRole: Generic,
        ClusterRoleBinding: Generic,
        Role: Generic,
        RoleBinding: Generic,
      },
    },
    batch: { v1: { CronJob: Generic } },
    Provider: class {
      readonly mock = true;
    },
  };
});
vi.mock("@pulumi/pulumi", () => ({
  output,
  all: (vs: any[]) => output(vs),
  interpolate: (x: any) => x,
}));
vi.mock("../../src/observability/dashboards/index", () => ({
  createDashboards: () => {},
  lokiLogsDashboard: () => ({}),
}));
vi.mock("../../src/observability/alerts", () => ({
  createGlobalAlertRules: () => {},
  createPrometheusRule: () => {},
  buildAlertmanagerConfig: () => ({}),
}));
import { createObservabilityStack } from "../../src/observability/stack";
import { createTrivyExposureClassifier } from "../../src/platform/components/trivy-exposure-classifier";

afterEach(() => {
  releases.length = 0;
  budgets.length = 0;
  deployments.length = 0;
});
const cluster: any = { provider: {}, storageTiers: {} };
const stack = (parts: any) =>
  createObservabilityStack("obs", { cluster, domain: "example.com", ...parts });

describe("observability workload disruption budgets", () => {
  it("creates default one and multiple replica budgets with isolated selectors", () => {
    stack({
      prometheus: { enabled: true, podDisruptionBudget: {}, scheduling: { replicas: 3 } },
      grafana: { enabled: true, podDisruptionBudget: {} },
      alertmanager: { enabled: true, podDisruptionBudget: {}, scheduling: { replicas: 2 } },
      loki: { enabled: true, podDisruptionBudget: {}, scheduling: { replicas: 2 } },
      kubeStateMetrics: { podDisruptionBudget: {}, scheduling: { replicas: 2 } },
    });
    expect(budgets.map((x) => x.args.spec)).toEqual(
      expect.arrayContaining([
        {
          maxUnavailable: 1,
          selector: {
            matchLabels: {
              "app.kubernetes.io/name": "prometheus",
              "app.kubernetes.io/instance": "obs-kube-prometheus-stack",
            },
          },
        },
        {
          maxUnavailable: 1,
          selector: {
            matchLabels: {
              "app.kubernetes.io/name": "alertmanager",
              "app.kubernetes.io/instance": "obs-kube-prometheus-stack",
            },
          },
        },
        {
          maxUnavailable: 1,
          selector: {
            matchLabels: {
              "app.kubernetes.io/name": "loki",
              "app.kubernetes.io/instance": "obs-loki",
              "app.kubernetes.io/component": "single-binary",
            },
          },
        },
        {
          maxUnavailable: 1,
          selector: {
            matchLabels: {
              "app.kubernetes.io/name": "kube-state-metrics",
              "app.kubernetes.io/instance": "obs-kube-prometheus-stack",
            },
          },
        },
        {
          minAvailable: 1,
          selector: {
            matchLabels: {
              "app.kubernetes.io/name": "grafana",
              "app.kubernetes.io/instance": "obs-kube-prometheus-stack",
            },
          },
        },
      ])
    );
    const kps = releases.find((x) => x.args.chart === "kube-prometheus-stack");
    expect(kps.args.values.prometheus.prometheusSpec.replicas).toBe(3);
    expect(kps.args.values.alertmanager.alertmanagerSpec.replicas).toBe(2);
    expect(kps.args.values.kubeStateMetrics.replicas).toBe(2);
  });
  it("honors opt-out and keeps Loki workload spread scoped", () => {
    stack({
      prometheus: { enabled: true, podDisruptionBudget: { enabled: false } },
      loki: {
        enabled: true,
        podDisruptionBudget: { enabled: false },
        scheduling: { spread: { strategy: "topology-spread", mode: "required" } },
      },
    });
    expect(budgets).toHaveLength(0);
    const loki = releases.find((x) => x.args.chart === "loki");
    expect(
      loki.args.values.singleBinary.topologySpreadConstraints[0].labelSelector.matchLabels
    ).toEqual({ "app.kubernetes.io/name": "loki", "app.kubernetes.io/instance": "obs-loki" });
  });

  it("adds an isolated uptime Kuma budget using its configured replicas", () => {
    stack({
      uptimeKuma: {
        enabled: true,
        podDisruptionBudget: {},
        scheduling: { replicas: 2 },
        mariadbCluster: { createDatabase: () => ({ secrets: {} }) } as any,
      },
    });
    const release = releases.find((x) => x.args.chart === "uptime-kuma");
    expect(release.args.values.replicaCount).toBe(2);
    expect(budgets[0].args.spec).toEqual({
      maxUnavailable: 1,
      selector: {
        matchLabels: {
          "app.kubernetes.io/name": "uptime-kuma",
          "app.kubernetes.io/instance": "obs-uptime-kuma",
        },
      },
    });
  });
  it("applies replica, spread, and PDB policy to Nimbus classifier Deployment", () => {
    createTrivyExposureClassifier(
      "platform",
      {
        scheduling: { replicas: 3, spread: { strategy: "pod-anti-affinity", mode: "required" } },
        podDisruptionBudget: {},
      },
      {} as any
    );
    expect(deployments[0].args.spec.replicas).toBe(3);
    expect(
      deployments[0].args.spec.template.spec.affinity.podAntiAffinity
        .requiredDuringSchedulingIgnoredDuringExecution[0].labelSelector.matchLabels
    ).toEqual({ app: "trivy-exposure-classifier" });
    expect(budgets[0].args.spec).toEqual({
      maxUnavailable: 1,
      selector: { matchLabels: { app: "trivy-exposure-classifier" } },
    });
  });
  it("rejects shared policy on distributed Loki to prevent unmatched selectors", () => {
    expect(() =>
      stack({ loki: { enabled: true, mode: "distributed", podDisruptionBudget: {} } })
    ).toThrow(/per-workload availability settings/);
  });
  it("does not add disruption budgets to Alloy DaemonSets", () => {
    stack({ alloy: { enabled: true } });
    expect(releases.some((x) => x.args.chart === "alloy")).toBe(true);
    expect(budgets).toHaveLength(0);
  });
});
