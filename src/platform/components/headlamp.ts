/**
 * Headlamp Kubernetes dashboard deployment and plugin selection.
 *
 * @module platform/components/headlamp
 */

import type { ICluster } from "../../cluster";
import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import { stringify as stringifyYaml } from "yaml";
import type {
  IHeadlampConfig,
  IHeadlampPluginConfig,
  IHeadlampPluginId,
  IPlatformStackConfig,
} from "../interfaces";
import { ensureNamespace } from "../../utils/ensure-namespace";

/** Pinned CLI used by the upstream chart's plugin-manager init container. */
export const HEADLAMP_PLUGIN_MANAGER_VERSION = "0.1.1";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeValues(
  defaults: Record<string, unknown>,
  overrides: Readonly<Record<string, unknown>> | undefined
): Record<string, unknown> {
  if (!overrides) return defaults;
  const merged = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = merged[key];
    merged[key] = isRecord(existing) && isRecord(value) ? mergeValues(existing, value) : value;
  }
  return merged;
}

/** Deploy the in-cluster Headlamp Helm release with private and least-privilege defaults. */
export function deployHeadlamp(
  name: string,
  config: IHeadlampConfig,
  plugins: ReadonlyArray<IHeadlampPluginConfig>,
  provider: k8s.Provider,
  defaultVersion: string | undefined,
  dependsOn: ReadonlyArray<pulumi.Resource> = []
): k8s.helm.v3.Release {
  const namespace = config.namespace ?? "headlamp";
  const namespaceResource = ensureNamespace(namespace, provider);
  const pluginConfig = {
    plugins,
    installOptions: { parallel: true, maxConcurrent: 2 },
  };

  const mergedValues = mergeValues(
    {
      fullnameOverride: "headlamp",
      service: { type: "ClusterIP", port: 80 },
      ingress: { enabled: false },
      config: {
        inCluster: true,
        unsafeUseServiceAccountToken: false,
        watchPlugins: false,
        staticPlugins: { enabled: true },
      },
      clusterRoleBinding: {
        create: true,
        clusterRoleName: config.serviceAccountClusterRoleName ?? "view",
      },
    },
    config.values
  );
  const values = mergeValues(mergedValues, {
    fullnameOverride: "headlamp",
    service: { type: "ClusterIP", port: 80 },
    ingress: { enabled: false },
    config: {
      inCluster: true,
      unsafeUseServiceAccountToken: false,
      watchPlugins: false,
    },
    clusterRoleBinding: {
      create: true,
      clusterRoleName: config.serviceAccountClusterRoleName ?? "view",
    },
    pluginsManager: plugins.length
      ? {
          enabled: true,
          version: HEADLAMP_PLUGIN_MANAGER_VERSION,
          configContent: stringifyYaml(pluginConfig),
        }
      : { enabled: false },
  });

  return new k8s.helm.v3.Release(
    `${name}-headlamp`,
    {
      chart: "headlamp",
      repositoryOpts: { repo: "https://kubernetes-sigs.github.io/headlamp/" },
      version: config.version ?? defaultVersion,
      namespace,
      createNamespace: false,
      values,
    },
    { provider, dependsOn: [namespaceResource, ...dependsOn] }
  );
}

const INFERRED_PLUGINS: Readonly<Record<IHeadlampPluginId, IHeadlampPluginConfig>> = {
  "cert-manager": {
    name: "cert-manager",
    source: "https://artifacthub.io/packages/headlamp/headlamp-plugins/headlamp_cert-manager",
    version: "0.1.1",
  },
  karpenter: {
    name: "karpenter",
    source: "https://artifacthub.io/packages/headlamp/headlamp-plugins/headlamp_karpenter",
    version: "0.2.0",
  },
  argocd: {
    name: "argocd",
    source: "https://artifacthub.io/packages/headlamp/privilegedescalation/headlamp-argocd",
    version: "0.1.3",
  },
};

/**
 * Infer plugin integrations from enabled Nimbus components and append explicit plugins.
 * The caller is responsible for enabling Headlamp before deploying the component.
 */
export function resolveHeadlampPlugins(
  cluster: ICluster,
  config: Pick<IPlatformStackConfig, "argocd" | "certManager" | "headlamp">
): IHeadlampPluginConfig[] {
  const disabled = new Set(config.headlamp?.plugins?.disabled ?? []);
  const selectedIds: IHeadlampPluginId[] = [];

  const certManagerInstalled =
    cluster.eksAddons?.includes("cert-manager") === true || config.certManager?.enabled !== false;
  if (certManagerInstalled && !disabled.has("cert-manager")) {
    selectedIds.push("cert-manager");
  }

  if (
    cluster.nodePools.some((pool) => pool.scaling?.mode === "karpenter") &&
    !disabled.has("karpenter")
  ) {
    selectedIds.push("karpenter");
  }

  if (config.argocd?.enabled && !disabled.has("argocd")) {
    selectedIds.push("argocd");
  }

  const plugins = selectedIds.map((id) => INFERRED_PLUGINS[id]);
  const names = new Set(plugins.map((plugin) => plugin.name));

  for (const plugin of config.headlamp?.plugins?.additional ?? []) {
    validateAdditionalPlugin(plugin);
    if (names.has(plugin.name)) {
      throw new Error(
        `Headlamp plugin configuration contains a duplicate plugin name: ${plugin.name}`
      );
    }
    names.add(plugin.name);
    plugins.push({ ...plugin });
  }

  return plugins;
}

function validateAdditionalPlugin(plugin: IHeadlampPluginConfig): void {
  if (!plugin.name.trim()) {
    throw new Error("Headlamp plugin configuration requires a non-empty plugin name.");
  }
  if (!plugin.version.trim() || plugin.version.trim().toLowerCase() === "latest") {
    throw new Error(`Headlamp plugin "${plugin.name}" requires an explicit pinned version.`);
  }

  let source: URL;
  try {
    source = new URL(plugin.source);
  } catch {
    throw new Error(`Headlamp plugin "${plugin.name}" source must be a valid Artifact Hub URL.`);
  }

  const pathSegments = source.pathname.split("/").filter(Boolean);
  if (
    source.protocol !== "https:" ||
    source.hostname !== "artifacthub.io" ||
    source.username ||
    source.password ||
    source.search ||
    source.hash ||
    pathSegments.length < 4 ||
    pathSegments[0] !== "packages" ||
    pathSegments[1] !== "headlamp"
  ) {
    throw new Error(
      `Headlamp plugin "${plugin.name}" source must use an HTTPS Artifact Hub Headlamp package URL.`
    );
  }
}
