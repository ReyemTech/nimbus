/**
 * In-cluster Valkey cache deployment using the official Valkey Helm chart.
 *
 * @module cache/valkey
 */

import * as random from "@pulumi/random";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { resolveCloudTarget } from "../types";
import type { ResolvedCloudTarget } from "../types";
import { resolveStorageTier, type StorageTierMap } from "../types/storage-tiers";
import { ensureNamespace } from "../utils/ensure-namespace";
import { createPrometheusRule } from "../observability/alerts";
import { buildPodDisruptionBudgetSpec, resolvePodDisruptionBudget } from "../availability";
import { chartPodPlacement } from "../platform/components/scheduling";
import { nimbus } from "../nimbus";
import type { ICache, ICacheConfig } from "./interfaces";

const CACHE_NAMESPACE = "data";
const VALKEY_REPO = "https://valkey.io/valkey-helm/";
const DEFAULT_CHART_VERSION = "1.0.0";
const VALKEY_PORT = 6379;

/** Deploy Valkey through the official chart and return the shared cache contract. */
export function createValkeyCache(
  name: string,
  config: ICacheConfig,
  provider: k8s.Provider,
  storageTiers?: StorageTierMap
): ICache {
  const architecture = config.architecture ?? "replication";
  if (architecture === "cluster") {
    throw new Error(
      "Valkey does not support Nimbus cluster architecture; choose 'standalone' or 'replication'"
    );
  }
  if (architecture !== "standalone" && architecture !== "replication") {
    throw new Error(`Valkey does not support architecture '${architecture}'`);
  }

  const nodeReplicas =
    architecture === "replication" ? (config.scheduling?.replicas ?? config.replicas ?? 2) + 1 : 1;
  if (!Number.isInteger(nodeReplicas) || nodeReplicas < (architecture === "replication" ? 2 : 1)) {
    throw new Error("Valkey replication requires at least two Valkey pods, including the primary");
  }

  const pdbConfig = config.podDisruptionBudget ?? {};
  const nodeBudget = resolvePodDisruptionBudget(pdbConfig, nodeReplicas);
  const controllerBudget = resolvePodDisruptionBudget(pdbConfig, 3);
  if (architecture === "replication" && controllerBudget) {
    if ("minAvailable" in controllerBudget && pdbCount(controllerBudget.minAvailable, 3) < 2) {
      throw new Error(
        "Valkey Sentinel PodDisruptionBudget must preserve at least two of three pods"
      );
    }
    if ("maxUnavailable" in controllerBudget && pdbCount(controllerBudget.maxUnavailable, 3) > 1) {
      throw new Error("Valkey Sentinel PodDisruptionBudget must allow at most one unavailable pod");
    }
  }

  const resolved = resolveCloudTarget(config.cloud);
  const cloud: ResolvedCloudTarget = Array.isArray(resolved) ? resolved[0] : resolved;
  const namespace = ensureNamespace(CACHE_NAMESPACE, provider);
  const storageClass = resolveStorageTier(config.storageTier ?? "performance", storageTiers);
  const storageGb = config.storageGb ?? 8;
  const memory = config.memory ?? "256Mi";
  const secretName = `${name}-valkey-auth`;
  const valkeyPassword = new random.RandomPassword(`${name}-valkey-password`, {
    length: 40,
    special: false,
  });
  const sentinelPassword =
    architecture === "replication"
      ? new random.RandomPassword(`${name}-valkey-sentinel-password`, {
          length: 40,
          special: false,
        })
      : undefined;
  const authData: Record<string, pulumi.Input<string>> = { default: valkeyPassword.result };
  if (sentinelPassword) authData.sentinel = sentinelPassword.result;

  // The chart uses separate credentials for Valkey ACLs and Sentinel itself.
  // Keeping both in one Kubernetes Secret makes the credential handoff atomic.
  const authSecret = new k8s.core.v1.Secret(
    `${name}-valkey-auth-secret`,
    {
      metadata: {
        name: secretName,
        namespace: CACHE_NAMESPACE,
        labels: { "app.kubernetes.io/managed-by": "nimbus", "nimbus/cache": name },
      },
      stringData: authData,
    },
    { provider, dependsOn: [namespace] }
  );

  const chartBudget = (budget: ReturnType<typeof resolvePodDisruptionBudget>) => ({
    enabled: Boolean(budget),
    minAvailable: budget && "minAvailable" in budget ? budget.minAvailable : null,
    maxUnavailable: budget && "maxUnavailable" in budget ? budget.maxUnavailable : null,
  });

  const cacheSelector = { "nimbus/cache": name };
  const basePlacement = chartPodPlacement(config.scheduling?.spread, cacheSelector, {}, "Valkey");
  const sentinelPlacement = chartPodPlacement(
    config.scheduling?.spread,
    { ...cacheSelector, "app.kubernetes.io/component": "sentinel" },
    {},
    "Valkey Sentinel"
  );
  const haproxyPlacement = chartPodPlacement(
    config.scheduling?.spread,
    { ...cacheSelector, "app.kubernetes.io/component": "haproxy" },
    {},
    "Valkey HAProxy"
  );

  const values: Record<string, unknown> = {
    auth: {
      enabled: true,
      usersExistingSecret: secretName,
      aclUsers: { default: { permissions: "~* &* +@all" } },
    },
    podLabels: cacheSelector,
    persistence: {
      enabled: true,
      size: `${storageGb}Gi`,
      ...(storageClass ? { storageClass } : {}),
    },
    resources: {
      requests: { cpu: "100m", memory },
      limits: { memory },
    },
    podDisruptionBudget: chartBudget(nodeBudget),
    service: { type: "ClusterIP", port: VALKEY_PORT },
    ...basePlacement,
    metrics: { enabled: config.metrics ?? false },
    replica: {
      enabled: architecture === "replication",
      replicas: nodeReplicas,
      replicationUser: "default",
    },
    sentinel: {
      enabled: architecture === "replication",
      replicas: 3,
      monitorUser: "default",
      existingSecret: secretName,
      passwordKey: "sentinel",
      resources: {
        requests: { cpu: "25m", memory: "64Mi" },
        limits: { memory: "128Mi" },
      },
      podLabels: cacheSelector,
      podDisruptionBudget: chartBudget(controllerBudget),
      ...sentinelPlacement,
    },
    haproxy: {
      enabled: architecture === "replication",
      replicas: 3,
      checkUser: "default",
      service: { type: "ClusterIP", port: VALKEY_PORT },
      resources: {
        requests: { cpu: "50m", memory: "64Mi" },
        limits: { memory: "128Mi" },
      },
      podLabels: cacheSelector,
      podDisruptionBudget: chartBudget(controllerBudget),
      ...haproxyPlacement,
    },
  };

  const releaseName = `${name}-valkey`;
  const release = new k8s.helm.v3.Release(
    releaseName,
    {
      chart: "valkey",
      version: config.chartVersion ?? DEFAULT_CHART_VERSION,
      repositoryOpts: { repo: VALKEY_REPO },
      namespace: CACHE_NAMESPACE,
      createNamespace: false,
      values,
    },
    { provider, dependsOn: [namespace, authSecret] }
  );
  const actualReleaseName = release.status.apply((status) => status.name);
  const endpoint = actualReleaseName.apply((releaseName) =>
    architecture === "replication"
      ? `${releaseName}-haproxy.${CACHE_NAMESPACE}.svc.cluster.local`
      : `${releaseName}.${CACHE_NAMESPACE}.svc.cluster.local`
  );
  const port = pulumi.output(VALKEY_PORT);

  if (architecture === "standalone" && nodeBudget) {
    const spec = buildPodDisruptionBudgetSpec(pdbConfig, cacheSelector, nodeReplicas);
    new k8s.policy.v1.PodDisruptionBudget(
      `${name}-valkey-pdb`,
      {
        metadata: {
          name: `${name}-valkey`,
          namespace: CACHE_NAMESPACE,
          labels: { "app.kubernetes.io/managed-by": "nimbus" },
        },
        spec: spec?.spec,
      },
      { provider, dependsOn: [release] }
    );
  }

  if (config.metrics) {
    createPrometheusRule(
      `${name}-valkey-alerts`,
      "observability",
      [
        {
          name: `nimbus.valkey.${name}`,
          rules: [
            {
              alert: "ValkeyDown",
              expr: `redis_up{job=~".*${name}.*"} == 0`,
              for: "2m",
              labels: { severity: "critical" },
              annotations: { summary: `Valkey ${name} is DOWN` },
            },
          ],
        },
      ],
      provider,
      [release]
    );
  }

  const secrets: Record<string, pulumi.Output<string>> = {};
  for (const targetNamespace of config.namespaces ?? []) {
    const target = ensureNamespace(targetNamespace, provider);
    const appSecretName = `${name}-valkey`;
    new k8s.core.v1.Secret(
      `${name}-valkey-secret-${targetNamespace}`,
      {
        metadata: {
          name: appSecretName,
          namespace: targetNamespace,
          labels: { "app.kubernetes.io/managed-by": "nimbus", "nimbus/cache": name },
        },
        stringData: {
          host: endpoint,
          port: String(VALKEY_PORT),
          username: "default",
          password: valkeyPassword.result,
          uri: pulumi
            .all([endpoint, valkeyPassword.result])
            .apply(([host, password]) => `redis://default:${password}@${host}:${VALKEY_PORT}`),
        },
      },
      { provider, dependsOn: [release, target], ignoreChanges: ["data", "stringData"] }
    );
    secrets[targetNamespace] = pulumi.output(appSecretName);
  }

  const secretRef = { path: `${CACHE_NAMESPACE}/${secretName}`, key: "default" };
  nimbus.register(name, {
    name,
    type: "cache",
    namespace: CACHE_NAMESPACE,
    endpoint,
    port: VALKEY_PORT,
    secretRef: {
      name: secretName,
      keys: {
        password: "default",
        ...(architecture === "replication" ? { sentinel: "sentinel" } : {}),
      },
    },
    nativeResource: release,
  });

  return {
    name,
    cloud,
    engine: "valkey",
    endpoint,
    port,
    secretRef,
    secrets,
    nativeResource: release,
  };
}

function pdbCount(value: number | string, replicas: number) {
  if (typeof value === "number") return value;
  const percentage = Number.parseInt(value, 10) / 100;
  return Math.ceil(replicas * percentage);
}
