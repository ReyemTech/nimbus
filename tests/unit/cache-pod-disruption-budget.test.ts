/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
const resources: pulumi.runtime.MockResourceArgs[] = [];
const HELM = "kubernetes:helm.sh/v3:Release";
const PDB = "kubernetes:policy/v1:PodDisruptionBudget";
const DEPLOYMENT = "kubernetes:apps/v1:Deployment";
vi.mock("../../src/nimbus", () => ({ nimbus: { register: () => {} } }));
vi.mock("../../src/observability/alerts", () => ({ createPrometheusRule: () => {} }));
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
          data: {},
        },
      };
    },
    call: () => ({}),
  });
  provider = new k8s.Provider("test-cache", {});
});
import { createCache } from "../../src/cache/cache";
const byType = (type: string) => resources.filter((r) => r.type === type);
describe("cache workload disruption budgets", () => {
  it("maps Redis master and replica availability separately", async () => {
    createCache(
      "sessions",
      {
        cloud: "aws",
        engine: "redis",
        mode: "helm",
        architecture: "replication",
        replicas: 3,
        scheduling: { replicas: 4, spread: { strategy: "pod-anti-affinity", mode: "required" } },
      } as any,
      provider as any
    );
    await pulumi.runtime.disconnect();
    const release = byType(HELM)[0];
    const pdb = byType(PDB)[0];
    expect(release).toBeDefined();
    expect(pdb).toBeDefined();
    const values = (release?.inputs as any).values;
    expect(values.master.pdb).toEqual({ create: true, minAvailable: 1 });
    expect(values.replica.replicaCount).toBe(4);
    expect(values.replica.pdb).toEqual({ create: true, maxUnavailable: 1 });
    expect(
      values.replica.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0]
        .labelSelector.matchLabels
    ).toMatchObject({ "app.kubernetes.io/component": "replica" });
    expect((pdb?.inputs as any).spec).toEqual({
      maxUnavailable: 1,
      selector: { matchLabels: { app: "sessions-master-tracker" } },
    });
  });
  it("adds availability to Nimbus tracker and honors cache opt-out", async () => {
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
      provider as any
    );
    await pulumi.runtime.disconnect();
    const deployment = byType(DEPLOYMENT)[0];
    const release = byType(HELM)[0];
    expect((deployment?.inputs as any).spec.replicas).toBe(2);
    expect((release?.inputs as any).values.master.pdb).toEqual({ create: false });
    expect((release?.inputs as any).values.replica.pdb).toEqual({ create: false });
    expect(byType(PDB)).toHaveLength(0);
  });
});
