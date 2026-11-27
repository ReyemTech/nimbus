/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
const resources: pulumi.runtime.MockResourceArgs[] = [];
const HELM = "kubernetes:helm.sh/v3:Release";
const PDB = "kubernetes:policy/v1:PodDisruptionBudget";
const DEPLOYMENT = "kubernetes:apps/v1:Deployment";
let provider: k8s.Provider;
beforeEach(() => {
  resources.length = 0;
  pulumi.runtime.setMocks({
    newResource: (args) => {
      resources.push(args);
      return {
        id: args.name,
        state: {
          ...args.inputs,
          name: `${args.name}-actual`,
          status: { name: `${args.name}-actual` },
          spec: { clusterIP: "10.0.0.1" },
        },
      };
    },
    call: () => ({}),
  });
  provider = new k8s.Provider("test-observability", {});
});
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

const cluster = () => ({ provider, storageTiers: {} });
const stack = (parts: any) =>
  createObservabilityStack("obs", { cluster: cluster() as any, domain: "example.com", ...parts });
const byType = (type: string) => resources.filter((r) => r.type === type);

describe("observability workload disruption budgets", () => {
  it("creates default one and multiple replica budgets with isolated selectors", async () => {
    stack({
      prometheus: { enabled: true, podDisruptionBudget: {}, scheduling: { replicas: 3 } },
      grafana: { enabled: true, podDisruptionBudget: {} },
      alertmanager: { enabled: true, podDisruptionBudget: {}, scheduling: { replicas: 2 } },
      loki: { enabled: true, podDisruptionBudget: {}, scheduling: { replicas: 2 } },
      kubeStateMetrics: { podDisruptionBudget: {}, scheduling: { replicas: 2 } },
    });
    await pulumi.runtime.disconnect();
    expect(byType(PDB).map((x) => (x.inputs as any).spec)).toEqual(
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
    const kps = byType(HELM).find((x) => (x.inputs as any).chart === "kube-prometheus-stack");
    expect((kps?.inputs as any).values.prometheus.prometheusSpec.replicas).toBe(3);
    expect((kps?.inputs as any).values.alertmanager.alertmanagerSpec.replicas).toBe(2);
    expect((kps?.inputs as any).values.kubeStateMetrics.replicas).toBe(2);
  });
  it("honors opt-out and keeps Loki workload spread scoped", async () => {
    stack({
      prometheus: { enabled: true, podDisruptionBudget: { enabled: false } },
      loki: {
        enabled: true,
        podDisruptionBudget: { enabled: false },
        scheduling: { spread: { strategy: "topology-spread", mode: "required" } },
      },
    });
    await pulumi.runtime.disconnect();
    expect(byType(PDB)).toHaveLength(0);
    const loki = byType(HELM).find((x) => (x.inputs as any).chart === "loki");
    expect(
      (loki?.inputs as any).values.singleBinary.topologySpreadConstraints[0].labelSelector
        .matchLabels
    ).toEqual({ "app.kubernetes.io/name": "loki", "app.kubernetes.io/instance": "obs-loki" });
  });

  it("rejects replica scheduling unsupported by the pinned Uptime Kuma chart", () => {
    expect(() =>
      stack({
        uptimeKuma: {
          enabled: true,
          podDisruptionBudget: {},
          scheduling: { replicas: 2 },
          mariadbCluster: { createDatabase: () => ({ secrets: {} }) } as any,
        },
      })
    ).toThrow(/does not support scheduling.replicas/);
  });
  it("applies replica, spread, and PDB policy to Nimbus classifier Deployment", async () => {
    createTrivyExposureClassifier(
      "platform",
      {
        scheduling: { replicas: 3, spread: { strategy: "pod-anti-affinity", mode: "required" } },
        podDisruptionBudget: {},
      },
      provider as any
    );
    await pulumi.runtime.disconnect();
    const deployment = byType(DEPLOYMENT)[0];
    const pdb = byType(PDB)[0];
    expect(deployment).toBeDefined();
    expect(pdb).toBeDefined();
    expect((deployment?.inputs as any).spec.replicas).toBe(3);
    expect(
      (deployment?.inputs as any).spec.template.spec.affinity.podAntiAffinity
        .requiredDuringSchedulingIgnoredDuringExecution[0].labelSelector.matchLabels
    ).toEqual({ app: "trivy-exposure-classifier" });
    expect((pdb?.inputs as any).spec).toEqual({
      maxUnavailable: 1,
      selector: { matchLabels: { app: "trivy-exposure-classifier" } },
    });
  });
  it("rejects Nimbus PDBs that conflict with raw chart PDBs", () => {
    expect(() =>
      stack({
        prometheus: {
          enabled: true,
          podDisruptionBudget: {},
          values: { prometheus: { prometheusSpec: { podDisruptionBudget: { enabled: true } } } },
        },
      })
    ).toThrow(/conflicts with raw Helm PDB/);
  });
  it("maps distributed Loki policy to independently selected long-running components", async () => {
    stack({
      loki: {
        enabled: true,
        mode: "distributed",
        podDisruptionBudget: {},
        scheduling: { replicas: 2 },
      },
    });
    await pulumi.runtime.disconnect();
    const release = byType(HELM).find((x) => (x.inputs as any).chart === "loki");
    expect((release?.inputs as any).values).toMatchObject({
      deploymentMode: "Distributed",
      read: { replicas: 2 },
      write: { replicas: 2 },
      backend: { replicas: 2 },
    });
    const read = byType(PDB).find((x) => x.name === "obs-loki-read-pdb");
    expect((read?.inputs as any).spec.selector.matchLabels).toEqual({
      "app.kubernetes.io/name": "loki",
      "app.kubernetes.io/instance": "obs-loki",
      "app.kubernetes.io/component": "read",
    });
    expect(byType(PDB)).toHaveLength(12);
  });
  it("matches Uptime Kuma nameOverride in its registered PDB selector", async () => {
    stack({
      uptimeKuma: {
        enabled: true,
        podDisruptionBudget: {},
        values: { nameOverride: "custom-kuma" },
        mariadbCluster: { createDatabase: () => ({ secrets: {} }) } as any,
      },
    });
    await pulumi.runtime.disconnect();
    const pdb = byType(PDB).find((x) => x.name === "obs-uptime-kuma-pdb");
    expect((pdb?.inputs as any).spec.selector.matchLabels["app.kubernetes.io/name"]).toBe(
      "custom-kuma"
    );
  });
  it("does not add disruption budgets to Alloy DaemonSets", async () => {
    stack({ alloy: { enabled: true } });
    await pulumi.runtime.disconnect();
    expect(byType(HELM).some((x) => (x.inputs as any).chart === "alloy")).toBe(true);
    expect(byType(PDB)).toHaveLength(0);
  });
});
