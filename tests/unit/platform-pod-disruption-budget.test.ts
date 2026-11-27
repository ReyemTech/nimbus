/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-extraneous-class, @typescript-eslint/no-useless-constructor, @typescript-eslint/no-non-null-assertion */
import { afterEach, describe, expect, it, vi } from "vitest";

const releases: Array<{ name: string; args: any; opts: any; resource?: unknown }> = [];
const budgets: Array<{ name: string; args: any; opts: any }> = [];
const mockProvider = {} as any;

vi.mock("../../src/utils/ensure-namespace", () => ({ ensureNamespace: () => ({}) }));

vi.mock("@pulumi/kubernetes", () => {
  class Release {
    constructor(name: string, args: any, opts: any) {
      releases.push({ name, args, opts, resource: this });
    }
  }
  class PodDisruptionBudget {
    constructor(name: string, args: any, opts: any) {
      budgets.push({ name, args, opts });
    }
  }
  class Namespace {
    constructor() {}
  }
  return {
    helm: { v3: { Release } },
    policy: { v1: { PodDisruptionBudget } },
    core: { v1: { Namespace } },
  };
});

import { deployArgocd } from "../../src/platform/components/argocd";
import { deployCertManager } from "../../src/platform/components/cert-manager";
import { deployExternalDns } from "../../src/platform/components/external-dns";
import { deployExternalSecrets } from "../../src/platform/components/external-secrets";
import { deployTraefik } from "../../src/platform/components/traefik";
import { deployVault } from "../../src/platform/components/vault";
import { deployDescheduler } from "../../src/platform/components/descheduler";
import { deployOAuth2Proxy } from "../../src/platform/components/oauth2-proxy";
import { deployTrivyOperator } from "../../src/platform/components/trivy-operator";

function reset() {
  releases.length = 0;
  budgets.length = 0;
}
afterEach(reset);

const componentCases = [
  {
    name: "descheduler",
    run: (config: any) =>
      deployDescheduler(
        "test",
        { ...config, values: { kind: "Deployment", ...config.values } },
        mockProvider,
        "1.0.0"
      ),
    release: "test-descheduler",
    nativePaths: [["podDisruptionBudget"]],
    replicaPaths: [["replicas"]],
    rawValues: { kind: "Deployment", replicas: 2 },
    spreadPaths: [
      [
        "topologySpreadConstraints",
        {
          "app.kubernetes.io/name": "descheduler",
          "app.kubernetes.io/instance": "test-descheduler",
        },
      ],
    ],
    placementPaths: [],
  },
  {
    name: "oauth2-proxy",
    run: (config: any) =>
      deployOAuth2Proxy(
        "test",
        { provider: "google", clientId: "id", clientSecret: "secret", ...config },
        "example.com",
        mockProvider,
        "1.0.0"
      ),
    release: "test-oauth2-proxy",
    nativePaths: [["podDisruptionBudget"]],
    replicaPaths: [["replicaCount"]],
    rawValues: { replicaCount: 2 },
    spreadPaths: [
      [
        "topologySpreadConstraints",
        {
          "app.kubernetes.io/name": "oauth2-proxy",
          "app.kubernetes.io/instance": "test-oauth2-proxy",
        },
      ],
    ],
    placementPaths: [],
  },
  {
    name: "trivy-operator",
    run: (config: any) => deployTrivyOperator("test", config, mockProvider, "1.0.0"),
    release: "test-trivy-operator",
    fallback: [
      {
        namespace: "trivy-system",
        selector: {
          "app.kubernetes.io/name": "trivy-operator",
          "app.kubernetes.io/instance": "test-trivy-operator",
        },
      },
    ],
    replicaPaths: [["operator", "replicas"]],
    rawValues: { operator: { replicas: 2 } },
    spreadPaths: [
      [
        "operator",
        "topologySpreadConstraints",
        {
          "app.kubernetes.io/name": "trivy-operator",
          "app.kubernetes.io/instance": "test-trivy-operator",
        },
      ],
    ],
    placementPaths: [],
  },
  {
    name: "traefik",
    run: (config: any) => deployTraefik("test", config, mockProvider, "1.0.0"),
    release: "test-traefik",
    nativePaths: [["podDisruptionBudget"]],
    replicaPaths: [["deployment", "replicas"]],
    rawValues: { deployment: { replicas: 2 } },
    spreadPaths: [
      [
        "topologySpreadConstraints",
        { "app.kubernetes.io/name": "traefik", "app.kubernetes.io/instance": "test-traefik" },
      ],
    ],
    placementPaths: [
      [
        "affinity",
        { "app.kubernetes.io/name": "traefik", "app.kubernetes.io/instance": "test-traefik" },
      ],
    ],
  },
  {
    name: "cert-manager",
    run: (config: any) => deployCertManager("test", config, mockProvider, "1.0.0"),
    release: "test-cert-manager",
    nativePaths: [
      ["podDisruptionBudget"],
      ["webhook", "podDisruptionBudget"],
      ["cainjector", "podDisruptionBudget"],
    ],
    replicaPaths: [["replicaCount"], ["webhook", "replicaCount"], ["cainjector", "replicaCount"]],
    rawValues: { replicaCount: 2, webhook: { replicaCount: 2 }, cainjector: { replicaCount: 2 } },
    spreadPaths: [
      [
        "topologySpreadConstraints",
        {
          "app.kubernetes.io/name": "cert-manager",
          "app.kubernetes.io/instance": "test-cert-manager",
        },
      ],
      [
        "webhook",
        "topologySpreadConstraints",
        { "app.kubernetes.io/name": "webhook", "app.kubernetes.io/instance": "test-cert-manager" },
      ],
      [
        "cainjector",
        "topologySpreadConstraints",
        {
          "app.kubernetes.io/name": "cainjector",
          "app.kubernetes.io/instance": "test-cert-manager",
        },
      ],
    ],
    placementPaths: [
      [
        "affinity",
        {
          "app.kubernetes.io/name": "cert-manager",
          "app.kubernetes.io/instance": "test-cert-manager",
        },
      ],
      [
        "webhook",
        "affinity",
        { "app.kubernetes.io/name": "webhook", "app.kubernetes.io/instance": "test-cert-manager" },
      ],
      [
        "cainjector",
        "affinity",
        {
          "app.kubernetes.io/name": "cainjector",
          "app.kubernetes.io/instance": "test-cert-manager",
        },
      ],
    ],
  },
  {
    name: "external-dns",
    run: (config: any) =>
      deployExternalDns("test", { dnsProvider: "cloudflare", ...config }, mockProvider, "1.0.0"),
    release: "test-external-dns",
    fallback: [
      {
        namespace: "external-dns",
        selector: {
          "app.kubernetes.io/instance": "test-external-dns",
          "app.kubernetes.io/name": "external-dns",
        },
      },
    ],
    replicaPaths: [["replicaCount"]],
    rawValues: { replicaCount: 2 },
    spreadPaths: [
      [
        "topologySpreadConstraints",
        {
          "app.kubernetes.io/name": "external-dns",
          "app.kubernetes.io/instance": "test-external-dns",
        },
      ],
    ],
    placementPaths: [
      [
        "affinity",
        {
          "app.kubernetes.io/name": "external-dns",
          "app.kubernetes.io/instance": "test-external-dns",
        },
      ],
    ],
  },
  {
    name: "external-secrets",
    run: (config: any) => deployExternalSecrets("test", config, mockProvider, "1.0.0"),
    release: "test-external-secrets",
    nativePaths: [
      ["podDisruptionBudget"],
      ["webhook", "podDisruptionBudget"],
      ["certController", "podDisruptionBudget"],
    ],
    replicaPaths: [
      ["replicaCount"],
      ["webhook", "replicaCount"],
      ["certController", "replicaCount"],
    ],
    rawValues: {
      replicaCount: 2,
      webhook: { replicaCount: 2 },
      certController: { replicaCount: 2 },
    },
    spreadPaths: [
      [
        "topologySpreadConstraints",
        {
          "app.kubernetes.io/name": "external-secrets",
          "app.kubernetes.io/instance": "test-external-secrets",
        },
      ],
      [
        "webhook",
        "topologySpreadConstraints",
        {
          "app.kubernetes.io/name": "external-secrets-webhook",
          "app.kubernetes.io/instance": "test-external-secrets",
        },
      ],
      [
        "certController",
        "topologySpreadConstraints",
        {
          "app.kubernetes.io/name": "external-secrets-cert-controller",
          "app.kubernetes.io/instance": "test-external-secrets",
        },
      ],
    ],
    placementPaths: [
      [
        "affinity",
        {
          "app.kubernetes.io/name": "external-secrets",
          "app.kubernetes.io/instance": "test-external-secrets",
        },
      ],
      [
        "webhook",
        "affinity",
        {
          "app.kubernetes.io/name": "external-secrets-webhook",
          "app.kubernetes.io/instance": "test-external-secrets",
        },
      ],
      [
        "certController",
        "affinity",
        {
          "app.kubernetes.io/name": "external-secrets-cert-controller",
          "app.kubernetes.io/instance": "test-external-secrets",
        },
      ],
    ],
  },
  {
    name: "argocd",
    run: (config: any) => deployArgocd("test", config, "example.com", mockProvider, "1.0.0"),
    release: "test-argocd",
    nativePaths: [
      ["controller", "pdb"],
      ["server", "pdb"],
      ["repoServer", "pdb"],
    ],
    replicaPaths: [
      ["controller", "replicas"],
      ["server", "replicas"],
      ["repoServer", "replicas"],
      ["applicationSet", "replicas"],
    ],
    fallback: [
      {
        namespace: "argocd",
        selector: {
          "app.kubernetes.io/instance": "test-argocd",
          "app.kubernetes.io/name": "argocd-applicationset-controller",
        },
      },
      {
        namespace: "argocd",
        selector: {
          "app.kubernetes.io/instance": "test-argocd",
          "app.kubernetes.io/name": "argocd-notifications-controller",
        },
      },
    ],
    rawValues: {
      controller: { replicas: 2 },
      server: { replicas: 2 },
      repoServer: { replicas: 2 },
      applicationSet: { replicas: 2 },
    },
    spreadPaths: [
      [
        "controller",
        "topologySpreadConstraints",
        {
          "app.kubernetes.io/name": "argocd-application-controller",
          "app.kubernetes.io/instance": "test-argocd",
        },
      ],
      [
        "server",
        "topologySpreadConstraints",
        { "app.kubernetes.io/name": "argocd-server", "app.kubernetes.io/instance": "test-argocd" },
      ],
      [
        "repoServer",
        "topologySpreadConstraints",
        {
          "app.kubernetes.io/name": "argocd-repo-server",
          "app.kubernetes.io/instance": "test-argocd",
        },
      ],
      [
        "applicationSet",
        "topologySpreadConstraints",
        {
          "app.kubernetes.io/name": "argocd-applicationset-controller",
          "app.kubernetes.io/instance": "test-argocd",
        },
      ],
      [
        "notifications",
        "topologySpreadConstraints",
        {
          "app.kubernetes.io/name": "argocd-notifications-controller",
          "app.kubernetes.io/instance": "test-argocd",
        },
      ],
    ],
    placementPaths: [
      [
        "controller",
        "affinity",
        {
          "app.kubernetes.io/name": "argocd-application-controller",
          "app.kubernetes.io/instance": "test-argocd",
        },
      ],
      [
        "server",
        "affinity",
        { "app.kubernetes.io/name": "argocd-server", "app.kubernetes.io/instance": "test-argocd" },
      ],
      [
        "repoServer",
        "affinity",
        {
          "app.kubernetes.io/name": "argocd-repo-server",
          "app.kubernetes.io/instance": "test-argocd",
        },
      ],
      [
        "applicationSet",
        "affinity",
        {
          "app.kubernetes.io/name": "argocd-applicationset-controller",
          "app.kubernetes.io/instance": "test-argocd",
        },
      ],
      [
        "notifications",
        "affinity",
        {
          "app.kubernetes.io/name": "argocd-notifications-controller",
          "app.kubernetes.io/instance": "test-argocd",
        },
      ],
    ],
  },
  {
    name: "vault",
    run: (config: any) => deployVault("test", config, "example.com", mockProvider, "1.0.0"),
    release: "test-vault",
    fallback: [
      {
        namespace: "vault",
        selector: {
          "app.kubernetes.io/instance": "test-vault",
          "app.kubernetes.io/name": "vault",
          "app.kubernetes.io/component": "server",
        },
      },
    ],
    nativePathsHa: [["server", "ha", "disruptionBudget"]],
    replicaPaths: [["server", "ha", "replicas"]],
    rawValues: { server: { ha: { enabled: true, replicas: 2 } } },
    spreadPaths: [
      [
        "server",
        "topologySpreadConstraints",
        {
          "app.kubernetes.io/name": "vault",
          "app.kubernetes.io/instance": "test-vault",
          "app.kubernetes.io/component": "server",
        },
      ],
    ],
    placementPaths: [
      [
        "server",
        "affinity",
        {
          "app.kubernetes.io/name": "vault",
          "app.kubernetes.io/instance": "test-vault",
          "app.kubernetes.io/component": "server",
        },
      ],
    ],
  },
];

describe.each(componentCases)(
  "$name availability integration",
  ({
    run,
    release,
    nativePaths = [],
    nativePathsHa = [],
    replicaPaths,
    placementPaths = [],
    rawValues = {},
    spreadPaths = [],
    fallback = [],
  }) => {
    it("protects each managed workload without overlapping PDBs", () => {
      const values = run({
        enabled: true,
        podDisruptionBudget: {},
        scheduling: {},
        bootstrap: false,
      }) as any;
      const chartValues = releases.find((entry) => entry.name === release)!.args.values;
      for (const path of nativePaths) {
        const pdb = path.reduce((value: any, key: string) => value?.[key], chartValues);
        expect(pdb).toEqual({ enabled: true, minAvailable: 1 });
      }
      expect(budgets).toHaveLength(fallback.length);
      fallback.forEach((workload: any, index: number) => {
        expect(budgets[index]!.args.metadata.namespace).toBe(workload.namespace);
        expect(budgets[index]!.args.spec).toEqual({
          minAvailable: 1,
          selector: { matchLabels: workload.selector },
        });
        expect(budgets[index]!.opts.dependsOn).toContain(values);
      });
    });

    it("translates two replicas and required topology spread to each workload", () => {
      run({
        enabled: true,
        podDisruptionBudget: {},
        scheduling: {
          replicas: 2,
          spread: {
            strategy: "topology-spread",
            topologyKey: "topology.kubernetes.io/zone",
            mode: "required",
          },
        },
        ha: true,
        bootstrap: false,
      });
      const chartValues = releases.find((entry) => entry.name === release)!.args.values;
      for (const path of [...nativePaths, ...nativePathsHa]) {
        const pdb = path.reduce((value: any, key: string) => value?.[key], chartValues);
        expect(pdb).toEqual({ enabled: true, maxUnavailable: 1 });
      }
      for (const path of replicaPaths) {
        expect(path.reduce((value: any, key: string) => value?.[key], chartValues)).toBe(2);
      }
      for (const check of spreadPaths as any[]) {
        const path = [...check.slice(0, -1)] as string[];
        const selector = check[check.length - 1] as Record<string, string> | undefined;
        const expected = {
          maxSkew: 1,
          topologyKey: "topology.kubernetes.io/zone",
          whenUnsatisfiable: "DoNotSchedule",
          ...(selector ? { labelSelector: { matchLabels: selector } } : {}),
        };
        expect(path.reduce((value: any, key: string) => value?.[key], chartValues)).toEqual([
          expected,
        ]);
      }
      if (release === "test-external-dns" || release === "test-argocd") {
        expect(budgets).toHaveLength(fallback.length);
        if (release === "test-external-dns") expect(budgets[0]!.args.spec.maxUnavailable).toBe(1);
        if (release === "test-argocd") {
          expect(budgets[0]!.args.spec.maxUnavailable).toBe(1);
          expect(budgets[1]!.args.spec).toEqual({
            minAvailable: 1,
            selector: { matchLabels: fallback[1]!.selector },
          });
        }
      }
    });

    it("maps pod anti-affinity to each managed workload", () => {
      run({
        enabled: true,
        scheduling: { spread: { strategy: "pod-anti-affinity", mode: "required" } },
        ha: true,
        bootstrap: false,
      });
      const chartValues = releases.find((entry) => entry.name === release)!.args.values;
      for (const check of placementPaths as any[]) {
        const path = check.slice(0, -1) as string[];
        const selector = check[check.length - 1] as Record<string, string>;
        expect(path.reduce((value: any, key: string) => value?.[key], chartValues)).toEqual({
          podAntiAffinity: {
            requiredDuringSchedulingIgnoredDuringExecution: [
              {
                topologyKey: "kubernetes.io/hostname",
                labelSelector: { matchLabels: selector },
                matchLabelKeys: ["app.kubernetes.io/instance"],
              },
            ],
          },
        });
      }
    });

    it("rejects conflicts between typed and raw placement values", () => {
      const cases = placementPaths.flatMap((check: any[]) => {
        const path = check.slice(0, -1) as string[];
        return ["affinity", "topologySpreadConstraints"].map((kind) => ({
          path: [...path.slice(0, -1), kind],
          kind,
        }));
      });
      if (release === "test-argocd") {
        cases.push({
          path: ["global", "topologySpreadConstraints"],
          kind: "topologySpreadConstraints",
        });
      }
      for (const { path, kind } of cases) {
        reset();
        const values: Record<string, any> = {};
        setNested(values, path, kind === "affinity" ? {} : []);
        expect(() =>
          run({
            enabled: true,
            scheduling: { spread: { strategy: "topology-spread", mode: "required" } },
            values,
            ha: true,
            bootstrap: false,
          })
        ).toThrow(/scheduling\.spread conflicts with Helm pod spread values/);
      }
    });

    it("preserves raw replica counts and derives default budgets from them", () => {
      run({
        enabled: true,
        podDisruptionBudget: {},
        scheduling: {},
        values: rawValues,
        ha: true,
        bootstrap: false,
      });
      const chartValues = releases.find((entry) => entry.name === release)!.args.values;
      for (const path of replicaPaths) {
        expect(path.reduce((value: any, key: string) => value?.[key], chartValues)).toBe(2);
      }
      for (const path of [...nativePaths, ...nativePathsHa]) {
        expect(path.reduce((value: any, key: string) => value?.[key], chartValues)).toEqual({
          enabled: true,
          maxUnavailable: 1,
        });
      }
      if (release === "test-external-dns") expect(budgets[0]!.args.spec.maxUnavailable).toBe(1);
      if (release === "test-argocd") {
        expect(budgets[0]!.args.spec.maxUnavailable).toBe(1);
        expect(budgets[1]!.args.spec).toEqual({
          minAvailable: 1,
          selector: { matchLabels: fallback[1]!.selector },
        });
      }
    });

    it("disables native and standalone PDBs on opt-out", () => {
      run({ enabled: true, podDisruptionBudget: { enabled: false }, bootstrap: false });
      const chartValues = releases.find((entry) => entry.name === release)!.args.values;
      for (const path of nativePaths) {
        expect(path.reduce((value: any, key: string) => value?.[key], chartValues)).toEqual({
          enabled: false,
        });
      }
      expect(budgets).toHaveLength(0);
    });
  }
);

it("keeps Descheduler in CronJob mode and rejects requested PDB/scheduling", () => {
  expect(() =>
    deployDescheduler("test", { podDisruptionBudget: {} }, mockProvider, "1.0.0")
  ).toThrow(/requires values.kind: Deployment/);
  expect(releases).toHaveLength(0);
  expect(budgets).toHaveLength(0);
  deployDescheduler("test", {}, mockProvider, "1.0.0");
  expect(releases[0]!.args.values.kind).toBeUndefined();
  expect(budgets).toHaveLength(0);
});
it("rejects OAuth2 Proxy raw and typed PDB conflicts", () => {
  expect(() =>
    deployOAuth2Proxy(
      "test",
      {
        provider: "google",
        clientId: "id",
        clientSecret: "secret",
        podDisruptionBudget: {},
        values: { podDisruptionBudget: { enabled: false } },
      },
      "example.com",
      mockProvider,
      "1.0.0"
    )
  ).toThrow(/podDisruptionBudget conflicts with Helm values/);
  expect(releases).toHaveLength(0);
});
it("keeps raw Trivy operator values while applying typed replicas and spread", () => {
  deployTrivyOperator(
    "test",
    {
      podDisruptionBudget: {},
      scheduling: {
        replicas: 3,
        spread: {
          strategy: "topology-spread",
          mode: "required",
          topologyKey: "topology.kubernetes.io/zone",
        },
      },
      values: { operator: { scanJobTimeout: "20m", replicas: 2 } },
    },
    mockProvider,
    "1.0.0"
  );
  const operator = releases[0]!.args.values.operator;
  expect(operator.scanJobTimeout).toBe("20m");
  expect(operator.replicas).toBe(3);
  expect(operator.topologySpreadConstraints).toEqual([
    {
      maxSkew: 1,
      topologyKey: "topology.kubernetes.io/zone",
      whenUnsatisfiable: "DoNotSchedule",
      labelSelector: {
        matchLabels: {
          "app.kubernetes.io/name": "trivy-operator",
          "app.kubernetes.io/instance": "test-trivy-operator",
        },
      },
    },
  ]);
  expect(budgets[0]!.args.spec.maxUnavailable).toBe(1);
});

it("keeps Argo CD native PDBs per controller and a separate notifications PDB", () => {
  deployArgocd(
    "test",
    { podDisruptionBudget: {}, scheduling: {} },
    "example.com",
    mockProvider,
    "1.0.0"
  );
  const values = releases[0]!.args.values;
  expect([values.controller.pdb, values.server.pdb, values.repoServer.pdb]).toEqual([
    { enabled: true, minAvailable: 1 },
    { enabled: true, minAvailable: 1 },
    { enabled: true, minAvailable: 1 },
  ]);
  expect(budgets).toHaveLength(2);
  expect(
    budgets.map((budget) => budget.args.spec.selector.matchLabels["app.kubernetes.io/name"])
  ).toEqual(["argocd-applicationset-controller", "argocd-notifications-controller"]);
});

it("rejects Vault HA percentage budgets that its integer-only native PDB cannot represent", () => {
  expect(() =>
    deployVault(
      "test",
      { ha: true, podDisruptionBudget: { maxUnavailable: "50%" }, bootstrap: false },
      "example.com",
      mockProvider,
      "1.0.0"
    )
  ).toThrow("Vault HA supports only integer maxUnavailable values");
});

it("rejects unsafe Vault standalone scaling before registering resources", () => {
  expect(() =>
    deployVault(
      "test",
      { ha: false, scheduling: { replicas: 2 }, podDisruptionBudget: {}, bootstrap: false },
      "example.com",
      mockProvider,
      "1.0.0"
    )
  ).toThrow();
  expect(releases).toHaveLength(0);
  expect(budgets).toHaveLength(0);
});

it("rejects Vault standalone mode when raw Helm values enable HA", () => {
  expect(() =>
    deployVault(
      "test",
      { ha: false, values: { server: { ha: { enabled: true, replicas: 3 } } }, bootstrap: false },
      "example.com",
      mockProvider,
      "1.0.0"
    )
  ).toThrow(/ha conflicts with Helm values\.server\.ha\.enabled/);
  expect(releases).toHaveLength(0);
  expect(budgets).toHaveLength(0);
});

it("preserves user External DNS environment and generated Route53 credentials", () => {
  deployExternalDns(
    "test",
    {
      dnsProvider: "route53",
      values: { env: [{ name: "CUSTOM_FLAG", value: "enabled" }] },
    },
    mockProvider,
    "1.0.0",
    [
      { name: "AWS_ACCESS_KEY_ID", value: "managed-key" },
      { name: "AWS_SECRET_ACCESS_KEY", value: "managed-secret" },
    ]
  );
  const env = releases[0]!.args.values.env as Array<Record<string, unknown>>;
  expect(env).toContainEqual({ name: "CUSTOM_FLAG", value: "enabled" });
  expect(env).toContainEqual({ name: "AWS_ACCESS_KEY_ID", value: "managed-key" });
  expect(env).toContainEqual({ name: "AWS_SECRET_ACCESS_KEY", value: "managed-secret" });
});

function setNested(target: Record<string, any>, path: string[], value: unknown): void {
  const leaf = path.pop();
  let cursor = target;
  for (const key of path) cursor = cursor[key] ??= {};
  if (leaf) cursor[leaf] = value;
}
