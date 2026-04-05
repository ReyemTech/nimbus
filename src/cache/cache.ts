/**
 * Cache implementation — deploys Bitnami Redis via Helm.
 *
 * Supports standalone and replication (Sentinel) architectures.
 * Authentication is always enabled; Bitnami creates a `{releaseName}-redis`
 * secret with a `redis-password` key.
 *
 * @module cache/cache
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { resolveCloudTarget } from "../types";
import type { ResolvedCloudTarget } from "../types";
import { nimbus } from "../nimbus";
import { resolveStorageTier, type StorageTierMap } from "../types/storage-tiers";
import { ensureNamespace } from "../utils/ensure-namespace";
import type { ICacheConfig, ICache } from "./interfaces";
import { createPrometheusRule } from "../observability/alerts";

/** Target namespace for all cache deployments. */
const CACHE_NAMESPACE = "data";

/** Bitnami Helm repository URL. */
const BITNAMI_REPO = "https://charts.bitnami.com/bitnami";

/** Sentinel port (used when architecture is "replication"). */
const SENTINEL_PORT = 26379;

/** Redis standalone port. */
const REDIS_PORT = 6379;

/**
 * Deploy a Redis cache using the Bitnami Redis Helm chart.
 *
 * Defaults to `replication` architecture with Sentinel for HA.
 * Use `standalone` for single-node dev/test deployments.
 *
 * @example
 * ```typescript
 * const cache = createCache("session", {
 *   cloud: "aws",
 *   engine: "redis",
 *   mode: "helm",
 *   architecture: "replication",
 *   replicas: 2,
 *   storageGb: 5,
 *   metrics: true,
 * }, provider);
 * ```
 *
 * @param name - Logical name for the cache resource (used as Helm release name prefix)
 * @param config - Cache configuration
 * @param provider - Kubernetes provider to deploy into
 * @returns Deployed cache resource
 */
export function createCache(
  name: string,
  config: ICacheConfig,
  provider: k8s.Provider,
  storageTiers?: StorageTierMap
): ICache {
  // Resolve to a single cloud target (take the first when multi-cloud array is given)
  const resolved = resolveCloudTarget(config.cloud);
  const cloud: ResolvedCloudTarget = Array.isArray(resolved) ? resolved[0] : resolved;
  const architecture = config.architecture ?? "replication";
  const storageGb = config.storageGb ?? 8;
  const replicas = config.replicas ?? 2;

  // Ensure the data namespace exists
  const ns = ensureNamespace(CACHE_NAMESPACE, provider);

  const storageClass = resolveStorageTier(config.storageTier ?? "performance", storageTiers);

  // Build Helm values based on architecture
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const values: Record<string, any> = {
    architecture,
    auth: {
      enabled: true,
    },
    master: {
      persistence: {
        enabled: true,
        size: `${storageGb}Gi`,
        ...(storageClass ? { storageClass } : {}),
      },
    },
  };

  if (architecture === "replication") {
    values["sentinel"] = {
      enabled: true,
    };
    values["replica"] = {
      replicaCount: replicas,
      persistence: {
        enabled: true,
        size: `${storageGb}Gi`,
        ...(storageClass ? { storageClass } : {}),
      },
    };
  }

  if (config.metrics) {
    values["metrics"] = {
      enabled: true,
    };
  }

  // Deploy the Bitnami Redis chart
  const release = new k8s.helm.v3.Release(
    `${name}-redis`,
    {
      chart: "redis",
      repositoryOpts: { repo: BITNAMI_REPO },
      namespace: CACHE_NAMESPACE,
      createNamespace: false,
      values,
    },
    { provider, dependsOn: [ns] }
  );

  // Pulumi appends a random suffix to the Helm release name. Use the actual
  // release name from status for deriving service/secret names.
  const actualReleaseName = release.status.apply((s) => s.name);

  // Endpoint and port depend on architecture:
  //   replication → master service on Redis port 6379 (apps connect to master, not Sentinel)
  //   standalone  → master service on Redis port 6379
  const endpoint = actualReleaseName.apply(
    (rn) => `${rn}-master.${CACHE_NAMESPACE}.svc.cluster.local`
  );

  // Sentinel port for internal Pulumi use, app-facing port is always 6379
  const port = pulumi.output(architecture === "replication" ? SENTINEL_PORT : REDIS_PORT);

  // Bitnami creates a secret with the release name and key `redis-password`.
  // secretRef.path is a string; use a placeholder that matches the pattern.
  const helmReleaseName = `${name}-redis`;
  const secretRef = {
    path: `${helmReleaseName}`,
    key: "redis-password",
  };

  // Redis alert rules
  createPrometheusRule(
    `${name}-redis-alerts`,
    "observability",
    [
      {
        name: `nimbus.redis.${name}`,
        rules: [
          {
            alert: "RedisDown",
            expr: `redis_up{job=~".*${name}.*"} == 0`,
            for: "2m",
            labels: { severity: "critical" },
            annotations: { summary: `Redis ${name} is DOWN` },
          },
        ],
      },
    ],
    provider,
    [release]
  );

  // Replicate connection secrets to target namespaces
  const secrets: Record<string, pulumi.Output<string>> = {};

  if (config.namespaces?.length) {
    // Read the Bitnami-generated password from the data namespace
    const bitnamiSecret = k8s.core.v1.Secret.get(
      `${name}-redis-password-read`,
      pulumi.interpolate`${CACHE_NAMESPACE}/${actualReleaseName}`,
      { provider, dependsOn: [release] }
    );
    const password = bitnamiSecret.data.apply((d) =>
      Buffer.from(d?.["redis-password"] ?? "", "base64").toString()
    );

    const appPort = REDIS_PORT;

    for (const targetNs of config.namespaces) {
      const nsResource = ensureNamespace(targetNs, provider);
      const secretName = `${name}-redis`;

      new k8s.core.v1.Secret(
        `${name}-redis-secret-${targetNs}`,
        {
          metadata: {
            name: secretName,
            namespace: targetNs,
            labels: {
              "app.kubernetes.io/managed-by": "nimbus",
              "nimbus/cache": name,
            },
          },
          stringData: {
            host: endpoint,
            port: String(appPort),
            password,
            uri: pulumi.all([endpoint, password]).apply(
              ([h, pw]) => `redis://:${pw}@${h}:${appPort}`
            ),
          },
        },
        { provider, dependsOn: [release, nsResource], ignoreChanges: ["data", "stringData"] }
      );

      secrets[targetNs] = pulumi.output(secretName);
    }
  }

  nimbus.register(name, {
    name,
    type: "cache",
    namespace: CACHE_NAMESPACE,
    endpoint,
    port: architecture === "replication" ? SENTINEL_PORT : REDIS_PORT,
    secretRef: {
      name: helmReleaseName,
      keys: { password: "redis-password" },
    },
    nativeResource: release,
  });

  return {
    name,
    cloud,
    engine: config.engine,
    endpoint,
    port,
    secretRef,
    secrets,
    nativeResource: release,
  };
}
