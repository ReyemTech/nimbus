/**
 * Unit tests for observability stack deploy logic.
 *
 * Tests the createObservabilityStack function's component routing for
 * Prometheus, Grafana, Loki, Alloy, and Alertmanager.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockOutput = (val: unknown): any => ({
  apply: (fn: (v: unknown) => unknown) => mockOutput(fn(val)),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockProvider = (): any => ({});

// Track created resources
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdReleases: Array<{ name: string; args: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdNamespaces: Array<{ name: string; args: any }>;

// Mock @pulumi/kubernetes
vi.mock("@pulumi/kubernetes", () => {
  const mockRelease = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    status: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdReleases.push({ name, args });
      this.status = mockOutput({ namespace: "mock-ns" });
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockNamespace = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdNamespaces.push({ name, args });
    }
  };

  return {
    helm: { v3: { Release: mockRelease } },
    core: { v1: { Namespace: mockNamespace } },
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    Provider: class {},
  };
});

// Mock @pulumi/pulumi
vi.mock("@pulumi/pulumi", () => ({
  output: (val: unknown) => mockOutput(val),
  all: (vals: unknown[]) => ({
    apply: (fn: (...args: unknown[]) => unknown) => mockOutput(fn(vals)),
  }),
}));

import { createObservabilityStack } from "../../src/observability/stack";
import type { ICluster } from "../../src/cluster";

function makeCluster(name: string): ICluster {
  return {
    name,
    cloud: { provider: "aws", region: "us-east-1" },
    endpoint: mockOutput("https://mock"),
    kubeconfig: mockOutput("{}"),
    version: mockOutput("1.32"),
    nodePools: [],
    nativeResource: {} as ICluster["nativeResource"],
    provider: mockProvider(),
  };
}

beforeEach(() => {
  createdReleases = [];
  createdNamespaces = [];
});

describe("observability stack — kube-prometheus-stack", () => {
  it("deploys kube-prometheus-stack when prometheus enabled", () => {
    const cluster = makeCluster("test");
    createObservabilityStack("test", {
      cluster,
      domain: "example.com",
      prometheus: { enabled: true },
    });

    const release = createdReleases.find((r) => r.name.includes("kube-prometheus-stack"));
    expect(release).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(release!.args.chart).toBe("kube-prometheus-stack");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(release!.args.namespace).toBe("observability");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(release!.args.values.prometheus.enabled).toBe(true);
  });

  it("deploys grafana with sidecar when dashboardPersistence is configmap", () => {
    const cluster = makeCluster("test");
    createObservabilityStack("test", {
      cluster,
      domain: "example.com",
      grafana: { enabled: true, dashboardPersistence: "configmap" },
    });

    const release = createdReleases.find((r) => r.name.includes("kube-prometheus-stack"));
    expect(release).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const grafanaValues = release!.args.values.grafana;
    expect(grafanaValues.enabled).toBe(true);
    expect(grafanaValues.sidecar.dashboards.enabled).toBe(true);
    expect(grafanaValues.sidecar.dashboards.searchNamespace).toBe("ALL");
    expect(grafanaValues.sidecar.dashboards.label).toBe("grafana_dashboard");
  });

  it("uses custom subdomain for prometheus", () => {
    const cluster = makeCluster("test");
    createObservabilityStack("test", {
      cluster,
      domain: "example.com",
      prometheus: { enabled: true, subdomain: "metrics" },
    });

    const release = createdReleases.find((r) => r.name.includes("kube-prometheus-stack"));
    expect(release).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(release!.args.values.prometheus.ingress.hosts).toEqual(["metrics.example.com"]);
  });
});

describe("observability stack — loki", () => {
  it("deploys loki in single-binary mode", () => {
    const cluster = makeCluster("test");
    createObservabilityStack("test", {
      cluster,
      domain: "example.com",
      loki: { enabled: true, mode: "single-binary" },
    });

    const release = createdReleases.find((r) => r.name.includes("loki"));
    expect(release).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(release!.args.chart).toBe("loki");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(release!.args.values.deploymentMode).toBe("SingleBinary");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(release!.args.values.singleBinary.replicas).toBe(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(release!.args.values.loki.storage.type).toBe("filesystem");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(release!.args.values.gateway.enabled).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(release!.args.values.chunksCache.enabled).toBe(false);
  });
});

describe("observability stack — alloy", () => {
  it("deploys alloy when enabled", () => {
    const cluster = makeCluster("test");
    createObservabilityStack("test", {
      cluster,
      domain: "example.com",
      alloy: { enabled: true },
    });

    const release = createdReleases.find((r) => r.name.includes("alloy"));
    expect(release).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(release!.args.chart).toBe("alloy");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(release!.args.namespace).toBe("observability");
  });
});

describe("observability stack — skipped components", () => {
  it("skips components when nothing enabled", () => {
    const cluster = makeCluster("test");
    const result = createObservabilityStack("test", {
      cluster,
      domain: "example.com",
    });

    expect(createdReleases).toHaveLength(0);
    expect(Object.keys(result.components)).toHaveLength(0);
  });
});
