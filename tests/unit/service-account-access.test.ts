import { beforeAll, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { createServiceAccountAccess } from "../../src/access/service-account.js";
import type { ICluster } from "../../src/cluster/interfaces.js";

function value<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => {
    output.apply(resolve);
  });
}

beforeAll(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      const state: Record<string, unknown> = { ...args.inputs };
      if (args.name.endsWith("-access-token")) {
        state.data = { token: "test-token", "ca.crt": "test-ca" };
      }
      return { id: `${args.name}-id`, state };
    },
    call: () => ({}),
  });
});

function makeCluster(): ICluster {
  return {
    name: "test-cluster",
    cloud: { provider: "aws", region: "us-east-1" },
    endpoint: pulumi.output("https://api.example.test"),
    kubeconfig: pulumi.output("{}"),
    version: pulumi.output("1.32"),
    nodePools: [],
    nativeResource: new pulumi.ComponentResource("test:cluster", "test-cluster"),
    provider: new k8s.Provider("test-provider", {}),
  };
}

describe("createServiceAccountAccess", () => {
  it("creates a cluster-admin binding and secret portable kubeconfig", async () => {
    const access = createServiceAccountAccess("ci", {
      cluster: makeCluster(),
      scope: { type: "cluster", role: "cluster-admin" },
    });

    expect(await value(access.serviceAccount.metadata.namespace)).toBe("nimbus-access");
    expect(await value(access.serviceAccount.metadata.name)).toBe("ci");
    expect(await value(access.serviceAccount.automountServiceAccountToken)).toBe(false);
    expect(access.binding).toBeInstanceOf(k8s.rbac.v1.ClusterRoleBinding);
    expect(await value(access.tokenSecret.metadata.annotations)).toMatchObject({
      "kubernetes.io/service-account.name": "ci",
      "pulumi.com/waitFor": "jsonpath={.data.token}",
    });
    const kubeconfig = await value(access.kubeconfig);
    const parsed = JSON.parse(kubeconfig) as {
      clusters: Array<{ cluster: Record<string, string> }>;
      users: Array<{ user: Record<string, string> }>;
      contexts: Array<{ context: Record<string, string> }>;
      "current-context": string;
    };
    expect(parsed.clusters[0]?.cluster).toMatchObject({
      server: "https://api.example.test",
      "certificate-authority-data": "test-ca",
    });
    expect(parsed.users[0]?.user.token).toBe("test-token");
    expect(parsed.contexts[0]?.context.namespace).toBe("nimbus-access");
    expect(parsed["current-context"]).toBe("ci@test-cluster");
    expect(await pulumi.isSecret(access.kubeconfig)).toBe(true);
  });

  it("binds a namespace role to the service account in its own namespace", async () => {
    const access = createServiceAccountAccess("reader", {
      cluster: makeCluster(),
      namespace: "nimbus-access",
      scope: { type: "namespace", namespace: "apps", role: "view" },
    });

    expect(access.binding).toBeInstanceOf(k8s.rbac.v1.RoleBinding);
    expect(await value(access.binding.roleRef)).toEqual({
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: "view",
    });
    expect(await value(access.binding.metadata.namespace)).toBe("apps");
  });

  it("rejects a namespaced Role reference without a binding namespace", () => {
    expect(() =>
      createServiceAccountAccess("custom", {
        cluster: makeCluster(),
        scope: { type: "custom", roleRef: { kind: "Role", name: "reader" } },
      })
    ).toThrow(/namespace/i);
  });

  it("creates a namespaced binding for a caller-managed Role", async () => {
    const access = createServiceAccountAccess("custom", {
      cluster: makeCluster(),
      scope: { type: "custom", namespace: "apps", roleRef: { kind: "Role", name: "reader" } },
    });
    expect(access.binding).toBeInstanceOf(k8s.rbac.v1.RoleBinding);
    expect(await value(access.binding.roleRef)).toMatchObject({ kind: "Role", name: "reader" });
    expect(await value(access.binding.metadata.namespace)).toBe("apps");
  });

  it("supports a caller-managed ClusterRole binding at cluster scope", () => {
    const access = createServiceAccountAccess("custom-cluster", {
      cluster: makeCluster(),
      scope: { type: "custom", roleRef: { kind: "ClusterRole", name: "auditor" } },
    });
    expect(access.binding).toBeInstanceOf(k8s.rbac.v1.ClusterRoleBinding);
  });

  it("uses a caller-supplied API server endpoint override", async () => {
    const access = createServiceAccountAccess("override", {
      cluster: makeCluster(),
      server: "https://private-api.example.test",
      scope: { type: "cluster", role: "view" },
    });
    const parsed = JSON.parse(await value(access.kubeconfig)) as {
      clusters: Array<{ cluster: Record<string, string> }>;
    };
    expect(parsed.clusters[0]?.cluster.server).toBe("https://private-api.example.test");
  });
});
