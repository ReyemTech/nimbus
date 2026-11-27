/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const resources: pulumi.runtime.MockResourceArgs[] = [];
const HELM = "kubernetes:helm.sh/v3:Release";
const PDB = "kubernetes:policy/v1:PodDisruptionBudget";
const DEPLOYMENT = "kubernetes:apps/v1:Deployment";
const SECRET = "kubernetes:core/v1:Secret";

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
          result: "mock-valkey-password",
          data: {},
        },
      };
    },
    call: () => ({}),
  });
  provider = new k8s.Provider("test-cache", {});
});

import { createCache } from "../../src/cache/cache";

const byType = (type: string) => resources.filter((resource) => resource.type === type);
const readOutput = <T>(output: pulumi.Output<T>): Promise<T> =>
  new Promise((resolve) => {
    output.apply((value) => {
      resolve(value);
      return value;
    });
  });
const cacheConfig = (overrides: Record<string, unknown> = {}) =>
  ({ cloud: "aws", engine: "valkey", mode: "helm", ...overrides }) as any;

describe("cache engines", () => {
  it("keeps Redis as the default when engine is omitted", async () => {
    const cache = createCache("sessions", { cloud: "aws" }, provider);
    await pulumi.runtime.disconnect();

    expect(cache.engine).toBe("redis");
    expect(byType(HELM).map((resource) => (resource.inputs as any).chart)).toEqual(["redis"]);
  });

  it("deploys the official Valkey Sentinel chart with a master-aware write endpoint", async () => {
    const cache = createCache(
      "sessions",
      cacheConfig({
        architecture: "replication",
        replicas: 2,
        storageGb: 8,
        memory: "1Gi",
        metrics: true,
        namespaces: ["apps"],
        podDisruptionBudget: {},
        scheduling: { spread: { strategy: "pod-anti-affinity", mode: "required" } },
      }),
      provider
    );
    await pulumi.runtime.disconnect();

    const release = byType(HELM)[0];
    const values = (release?.inputs as any).values;
    expect((release?.inputs as any).chart).toBe("valkey");
    expect((release?.inputs as any).version).toBe("1.0.0");
    expect((release?.inputs as any).repositoryOpts.repo).toBe("https://valkey.io/valkey-helm/");
    expect(values.replica).toMatchObject({
      enabled: true,
      replicas: 3,
    });
    expect(values.persistence).toEqual({ enabled: true, size: "8Gi" });
    expect(values.sentinel).toMatchObject({ enabled: true, replicas: 3 });
    expect(values.haproxy).toMatchObject({ enabled: true, replicas: 3, service: { port: 6379 } });
    expect(values.auth).toMatchObject({
      enabled: true,
      usersExistingSecret: "sessions-valkey-auth",
      aclUsers: { default: { permissions: "~* &* +@all" } },
    });
    expect(values.podDisruptionBudget).toEqual({
      enabled: true,
      maxUnavailable: 1,
      minAvailable: null,
    });
    expect(values.sentinel.podDisruptionBudget.maxUnavailable).toBe(1);
    expect(values.haproxy.podDisruptionBudget.maxUnavailable).toBe(1);
    expect(values.metrics.enabled).toBe(true);
    expect(
      values.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution
    ).toBeDefined();
    expect(
      values.affinity.podAntiAffinity.requiredDuringSchedulingIgnoredDuringExecution[0]
        .labelSelector.matchLabels
    ).toMatchObject({
      "nimbus/cache": "sessions",
      "app.kubernetes.io/component": "valkey",
    });
    expect(values.metrics.service.labels).toMatchObject({ "nimbus/cache": "sessions" });
    const serviceMonitor = resources.find(
      (resource) => (resource.inputs as any).kind === "ServiceMonitor"
    );
    expect(serviceMonitor?.inputs).toMatchObject({
      apiVersion: "monitoring.coreos.com/v1",
      kind: "ServiceMonitor",
      metadata: { name: "sessions-valkey-metrics", namespace: "observability" },
      spec: {
        namespaceSelector: { matchNames: ["data"] },
        selector: { matchLabels: { "nimbus/cache": "sessions" } },
        endpoints: [{ port: "metrics", interval: "30s" }],
      },
    });
    expect(byType(DEPLOYMENT)).toHaveLength(0);
    expect(byType(PDB)).toHaveLength(0);
    expect(cache.engine).toBe("valkey");
    expect(await readOutput(cache.port)).toBe(6379);
    expect(await readOutput(cache.endpoint)).toBe(
      "sessions-valkey-actual-haproxy.data.svc.cluster.local"
    );
    expect(cache.secretRef).toEqual({ path: "data/sessions-valkey-auth", key: "default" });
    expect(
      byType(SECRET).some(
        (resource) => (resource.inputs as any).metadata?.name === "sessions-valkey-auth"
      )
    ).toBe(true);
  });

  it("creates a standalone PDB and reports the write service port", async () => {
    const cache = createCache(
      "local",
      cacheConfig({ architecture: "standalone", podDisruptionBudget: {} }),
      provider
    );
    await pulumi.runtime.disconnect();

    expect(await readOutput(cache.port)).toBe(6379);
    expect(await readOutput(cache.endpoint)).toBe("local-valkey-actual.data.svc.cluster.local");
    expect((byType(HELM)[0]?.inputs as any).values.replica.enabled).toBe(false);
    expect((byType(HELM)[0]?.inputs as any).values.sentinel.enabled).toBe(false);
    expect((byType(HELM)[0]?.inputs as any).values.haproxy.enabled).toBe(false);
    expect((byType(PDB)[0]?.inputs as any).spec).toEqual({
      minAvailable: 1,
      selector: { matchLabels: { "nimbus/cache": "local" } },
    });
  });

  it("honors the chart version override and cache PDB opt-out", async () => {
    createCache(
      "ephemeral",
      cacheConfig({
        architecture: "standalone",
        chartVersion: "1.1.0",
        podDisruptionBudget: { enabled: false },
      }),
      provider
    );
    await pulumi.runtime.disconnect();

    expect((byType(HELM)[0]?.inputs as any).version).toBe("1.1.0");
    expect(byType(PDB)).toHaveLength(0);
  });

  it.each([
    ["cluster architecture", { architecture: "cluster" }],
    ["managed mode", { mode: "managed" }],
  ])("rejects unsupported Valkey %s before creating resources", (_label, overrides) => {
    expect(() => createCache("sessions", cacheConfig(overrides), provider)).toThrow(/Valkey/);
    expect(resources).toHaveLength(0);
  });

  it("rejects Valkey PDB settings that would remove Sentinel quorum", () => {
    expect(() =>
      createCache("sessions", cacheConfig({ podDisruptionBudget: { maxUnavailable: 2 } }), provider)
    ).toThrow(/Sentinel PodDisruptionBudget must allow at most one/);
    expect(resources).toHaveLength(0);
  });
});
