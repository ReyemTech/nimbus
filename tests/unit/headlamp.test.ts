import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ICluster } from "../../src/cluster";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreatedReleases: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreatedRoles: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreatedBindings: any[] = [];
const mockNamespace = {};

vi.mock("@pulumi/kubernetes", () => ({
  helm: {
    v3: {
      // eslint-disable-next-line @typescript-eslint/no-extraneous-class
      Release: class {
        constructor(name: string, args: unknown, opts?: unknown) {
          Object.assign(this, { name, args, opts });
          mockCreatedReleases.push(this);
        }
      },
    },
  },
  rbac: {
    v1: {
      // eslint-disable-next-line @typescript-eslint/no-extraneous-class
      ClusterRole: class {
        constructor(name: string, args: unknown, opts?: unknown) {
          Object.assign(this, { name, args, opts });
          mockCreatedRoles.push(this);
        }
      },
      // eslint-disable-next-line @typescript-eslint/no-extraneous-class
      ClusterRoleBinding: class {
        constructor(name: string, args: unknown, opts?: unknown) {
          Object.assign(this, { name, args, opts });
          mockCreatedBindings.push(this);
        }
      },
    },
  },
}));

vi.mock("../../src/utils/ensure-namespace", () => ({
  ensureNamespace: () => mockNamespace,
}));

import { deployHeadlamp, resolveHeadlampPlugins } from "../../src/platform/components/headlamp";

function makeCluster(overrides: Partial<ICluster> = {}): ICluster {
  return {
    name: "test",
    cloud: { provider: "aws", region: "us-east-1" },
    endpoint: "https://example.test" as never,
    kubeconfig: "{}" as never,
    version: "1.32" as never,
    nodePools: [],
    nativeResource: {} as ICluster["nativeResource"],
    provider: {} as ICluster["provider"],
    ...overrides,
  };
}

describe("resolveHeadlampPlugins", () => {
  it("infers cert-manager once when installed as an EKS add-on", () => {
    const plugins = resolveHeadlampPlugins(makeCluster({ eksAddons: ["cert-manager"] }), {
      certManager: { enabled: true },
    });

    expect(plugins.filter((plugin) => plugin.name === "cert-manager")).toHaveLength(1);
  });

  it("does not infer cert-manager when it is disabled and absent from EKS", () => {
    const plugins = resolveHeadlampPlugins(makeCluster(), {
      certManager: { enabled: false },
    });

    expect(plugins.map((plugin) => plugin.name)).not.toContain("cert-manager");
  });

  it("infers Karpenter from a Karpenter-managed node pool", () => {
    const plugins = resolveHeadlampPlugins(
      makeCluster({
        nodePools: [
          {
            name: "burst",
            scaling: { mode: "karpenter", instanceTypes: ["m7i.large"] },
          },
        ],
      }),
      { certManager: { enabled: false } }
    );

    expect(plugins.map((plugin) => plugin.name)).toContain("karpenter");
  });

  it("infers Argo CD only when the platform component is enabled", () => {
    const enabled = resolveHeadlampPlugins(makeCluster(), {
      certManager: { enabled: false },
      argocd: { enabled: true },
    });
    const disabled = resolveHeadlampPlugins(makeCluster(), {
      certManager: { enabled: false },
      argocd: { enabled: false },
    });

    expect(enabled.map((plugin) => plugin.name)).toContain("argocd");
    expect(disabled.map((plugin) => plugin.name)).not.toContain("argocd");
  });

  it("allows disabling an inferred plugin and appending custom plugins", () => {
    const plugins = resolveHeadlampPlugins(makeCluster(), {
      argocd: { enabled: true },
      certManager: { enabled: false },
      headlamp: {
        enabled: true,
        plugins: {
          disabled: ["argocd"],
          additional: [
            {
              name: "custom",
              source: "https://artifacthub.io/packages/headlamp/example/custom",
              version: "1.2.3",
            },
          ],
        },
      },
    });

    expect(plugins.map((plugin) => plugin.name)).toEqual(["custom"]);
  });

  it("rejects a custom plugin that collides with an inferred plugin", () => {
    expect(() =>
      resolveHeadlampPlugins(makeCluster(), {
        certManager: { enabled: false },
        argocd: { enabled: true },
        headlamp: {
          enabled: true,
          plugins: {
            additional: [
              {
                name: "argocd",
                source: "https://artifacthub.io/packages/headlamp/example/custom",
                version: "1.2.3",
              },
            ],
          },
        },
      })
    ).toThrow(/duplicate.*argocd/i);
  });

  it.each([
    {
      name: "missing name",
      plugin: {
        name: " ",
        source: "https://artifacthub.io/packages/headlamp/example/custom",
        version: "1.0.0",
      },
    },
    {
      name: "non-Artifact Hub source",
      plugin: { name: "custom", source: "https://example.com/plugin.tgz", version: "1.0.0" },
    },
    {
      name: "missing version",
      plugin: {
        name: "custom",
        source: "https://artifacthub.io/packages/headlamp/example/custom",
        version: " ",
      },
    },
  ])("rejects custom plugin with $name", ({ plugin }) => {
    expect(() =>
      resolveHeadlampPlugins(makeCluster(), {
        certManager: { enabled: false },
        headlamp: { enabled: true, plugins: { additional: [plugin] } },
      })
    ).toThrow(/Headlamp plugin/i);
  });

  it("uses pinned versions for all inferred plugins", () => {
    const plugins = resolveHeadlampPlugins(
      makeCluster({
        eksAddons: ["cert-manager"],
        nodePools: [
          { name: "burst", scaling: { mode: "karpenter", instanceTypes: ["m7i.large"] } },
        ],
      }),
      { argocd: { enabled: true } }
    );

    expect(plugins.length).toBeGreaterThan(0);
    expect(plugins.every((plugin) => plugin.version && plugin.version !== "latest")).toBe(true);
  });
});

describe("deployHeadlamp", () => {
  beforeEach(() => {
    mockCreatedReleases.length = 0;
    mockCreatedRoles.length = 0;
    mockCreatedBindings.length = 0;
  });

  it("creates a private Headlamp release that authenticates with its read-only pod identity", () => {
    const prerequisite = {} as never;
    deployHeadlamp("prod", { enabled: true }, [], {} as never, "0.46.0", [prerequisite]);

    expect(mockCreatedReleases).toHaveLength(1);
    const release = mockCreatedReleases[0];
    const managedRoleName = mockCreatedRoles[0]?.args.metadata.name;
    expect(release?.name).toBe("prod-headlamp");
    expect(release?.args).toMatchObject({
      chart: "headlamp",
      repositoryOpts: { repo: "https://kubernetes-sigs.github.io/headlamp/" },
      version: "0.46.0",
      namespace: "headlamp",
      createNamespace: false,
      values: {
        fullnameOverride: "headlamp",
        serviceAccount: { create: true },
        automountServiceAccountToken: true,
        service: { type: "ClusterIP" },
        ingress: { enabled: false },
        config: {
          unsafeUseServiceAccountToken: true,
          watchPlugins: false,
          staticPlugins: { enabled: true },
        },
        clusterRoleBinding: { create: false, clusterRoleName: managedRoleName },
      },
    });
    expect(mockCreatedRoles).toHaveLength(1);
    expect(mockCreatedRoles[0]?.args.metadata.name).toMatch(/^nimbus-headlamp-reader-[a-f0-9]{8}$/);
    expect(mockCreatedRoles[0]?.args.rules).toEqual([
      { apiGroups: ["*"], resources: ["*"], verbs: ["get", "list", "watch"] },
    ]);
    expect(release?.args.values.clusterRoleBinding.clusterRoleName).toBe(
      mockCreatedRoles[0]?.args.metadata.name
    );
    expect(release?.opts?.dependsOn).toContain(mockNamespace);
    expect(release?.opts?.dependsOn).toContain(prerequisite);
    expect(release?.opts?.dependsOn).toContain(mockCreatedRoles[0]);
    expect(mockCreatedBindings).toHaveLength(1);
    expect(mockCreatedBindings[0]?.args.roleRef).toEqual({
      apiGroup: "rbac.authorization.k8s.io",
      kind: "ClusterRole",
      name: managedRoleName,
    });
    expect(mockCreatedBindings[0]?.args.subjects).toEqual([
      { kind: "ServiceAccount", name: "headlamp", namespace: "headlamp", apiGroup: "" },
    ]);
    expect(mockCreatedBindings[0]?.opts.dependsOn).toContain(release);
  });

  it("pins plugin-manager entries and keeps Nimbus security values over caller overrides", () => {
    const plugins = resolveHeadlampPlugins(
      makeCluster({
        eksAddons: ["cert-manager"],
        nodePools: [
          { name: "burst", scaling: { mode: "karpenter", instanceTypes: ["m7i.large"] } },
        ],
      }),
      { argocd: { enabled: true } }
    );
    deployHeadlamp(
      "prod",
      {
        enabled: true,
        serviceAccountClusterRoleName: "headlamp-observer",
        values: {
          replicaCount: 2,
          serviceAccount: { create: false },
          automountServiceAccountToken: false,
          service: { type: "LoadBalancer" },
          ingress: { enabled: true },
          config: { unsafeUseServiceAccountToken: false, watchPlugins: true },
          clusterRoleBinding: { clusterRoleName: "cluster-admin" },
        },
      },
      plugins,
      {} as never,
      undefined,
      []
    );

    const values = mockCreatedReleases[0]?.args.values;
    expect(mockCreatedRoles).toHaveLength(0);
    expect(mockCreatedBindings).toHaveLength(1);
    expect(mockCreatedBindings[0]?.args.roleRef.name).toBe("headlamp-observer");
    expect(values).toMatchObject({
      replicaCount: 2,
      serviceAccount: { create: true },
      automountServiceAccountToken: true,
      service: { type: "ClusterIP" },
      ingress: { enabled: false },
      config: {
        unsafeUseServiceAccountToken: true,
        watchPlugins: false,
        staticPlugins: { enabled: true },
      },
      clusterRoleBinding: { create: false, clusterRoleName: "headlamp-observer" },
      pluginsManager: {
        enabled: true,
        version: "0.1.1",
        configContent: expect.stringContaining("version: 0.1.1"),
      },
    });
    expect(values.pluginsManager.configContent).toContain("headlamp_cert-manager");
    expect(values.pluginsManager.configContent).toContain("headlamp_karpenter");
    expect(values.pluginsManager.configContent).toContain("headlamp-argocd");
    expect(values.pluginsManager.configContent).not.toContain("version: latest");
  });

  it("keeps token-based user authentication available when requested", () => {
    deployHeadlamp(
      "user-auth",
      {
        enabled: true,
        authentication: "user-token",
        values: { config: { unsafeUseServiceAccountToken: true } },
      },
      [],
      {} as never,
      undefined,
      []
    );

    expect(mockCreatedReleases[0]?.args.values.config.unsafeUseServiceAccountToken).toBe(false);
    expect(mockCreatedRoles).toHaveLength(0);
    expect(mockCreatedBindings).toHaveLength(0);
    expect(mockCreatedReleases[0]?.args.values.clusterRoleBinding.create).toBe(true);
    expect(mockCreatedReleases[0]?.args.values.clusterRoleBinding.clusterRoleName).toBe("view");
  });

  it("does not start the plugin manager when no dynamic plugins are selected", () => {
    deployHeadlamp(
      "no-plugins",
      { enabled: true, values: { config: { staticPlugins: { enabled: false } } } },
      [],
      {} as never,
      undefined,
      []
    );

    expect(mockCreatedReleases[0]?.args.values.pluginsManager).toMatchObject({ enabled: false });
    expect(mockCreatedReleases[0]?.args.values.config.staticPlugins.enabled).toBe(false);
  });
});
