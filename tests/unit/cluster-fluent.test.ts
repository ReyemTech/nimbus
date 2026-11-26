import { describe, expect, it, vi } from "vitest";
import type { ICluster } from "../../src/cluster/interfaces.js";

const delegates = vi.hoisted(() => ({
  serviceAccount: vi.fn((_name: unknown, _config: unknown) => ({ result: "service-account" })),
  accessGateway: vi.fn((_name: unknown, _config: unknown) => ({ result: "access-gateway" })),
  platformStack: vi.fn((_name: unknown, _config: unknown) => ({ result: "platform-stack" })),
  observabilityStack: vi.fn((_name: unknown, _config: unknown) => ({
    result: "observability-stack",
  })),
  operator: vi.fn((_type: unknown, _config: unknown) => ({ result: "operator" })),
  argoCD: vi.fn((_name: unknown, _config: unknown) => ({ result: "argocd" })),
}));

vi.mock("../../src/access", () => ({
  createServiceAccountAccess: delegates.serviceAccount,
  createAccessGateway: delegates.accessGateway,
}));
vi.mock("../../src/platform", () => ({ createPlatformStack: delegates.platformStack }));
vi.mock("../../src/observability", () => ({
  createObservabilityStack: delegates.observabilityStack,
}));
vi.mock("../../src/operator", () => ({ createOperator: delegates.operator }));
vi.mock("../../src/argocd", () => ({ createArgoCD: delegates.argoCD }));

import { withClusterFluentOperations } from "../../src/cluster/fluent.js";

function makeCluster(): ICluster {
  return {
    name: "prod",
    cloud: { provider: "aws", region: "us-east-1" },
    endpoint: {} as ICluster["endpoint"],
    kubeconfig: {} as ICluster["kubeconfig"],
    version: {} as ICluster["version"],
    nodePools: [],
    nativeResource: {} as ICluster["nativeResource"],
    provider: {} as ICluster["provider"],
  };
}

describe("cluster fluent operations", () => {
  it("delegates each high-level operation with its owning cluster", () => {
    const cluster = withClusterFluentOperations(makeCluster());
    expect(
      cluster.createServiceAccountAccess("ci", { scope: { type: "cluster", role: "view" } })
    ).toEqual({ result: "service-account" });
    expect(
      cluster.createAccessGateway("vpn", {
        provider: "tailscale",
        tailscale: { oauthClientId: "id", oauthClientSecret: "secret", routes: [] },
      })
    ).toEqual({ result: "access-gateway" });
    expect(cluster.createPlatformStack("platform", { domain: "example.test" })).toEqual({
      result: "platform-stack",
    });
    expect(cluster.createObservabilityStack("obs", { domain: "example.test" })).toEqual({
      result: "observability-stack",
    });
    expect(cluster.createOperator("neo4j", {})).toEqual({ result: "operator" });
    expect(cluster.createArgoCD("gitops", { helmRelease: {} as never })).toEqual({
      result: "argocd",
    });
    expect(delegates.serviceAccount).toHaveBeenCalledWith("ci", {
      scope: { type: "cluster", role: "view" },
      cluster,
    });
    expect(delegates.accessGateway.mock.calls[0]?.[1]).toMatchObject({
      cluster,
      provider: "tailscale",
    });
    expect(delegates.platformStack.mock.calls[0]?.[1]).toMatchObject({
      cluster,
      domain: "example.test",
    });
    expect(delegates.observabilityStack.mock.calls[0]?.[1]).toMatchObject({
      cluster,
      domain: "example.test",
    });
    expect(delegates.operator.mock.calls[0]?.[1]).toMatchObject({ cluster });
    expect(delegates.argoCD.mock.calls[0]?.[1]).toMatchObject({ cluster, helmRelease: {} });
  });

  it("does not require fluent methods on a caller-created ICluster", () => {
    const cluster: ICluster = makeCluster();
    expect(cluster.name).toBe("prod");
  });
});
