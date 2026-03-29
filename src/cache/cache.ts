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
import { ensureNamespace } from "../utils/ensure-namespace";
import type { ICacheConfig, ICache } from "./interfaces";

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
  provider: k8s.Provider
): ICache {
  // Resolve to a single cloud target (take the first when multi-cloud array is given)
  const resolved = resolveCloudTarget(config.cloud);
  const cloud: ResolvedCloudTarget = Array.isArray(resolved) ? resolved[0] : resolved;
  const architecture = config.architecture ?? "replication";
  const storageGb = config.storageGb ?? 8;
  const replicas = config.replicas ?? 2;

  // Ensure the data namespace exists
  const ns = ensureNamespace(CACHE_NAMESPACE, provider);

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

  // The Pulumi resource name becomes the Helm release name when no explicit
  // `name` is set in the Release spec. Bitnami Redis creates a secret named
  // `{releaseName}-redis` with a `redis-password` key.
  const helmReleaseName = `${name}-redis`;

  // Endpoint and port depend on architecture:
  //   replication → headless service on Sentinel port 26379
  //   standalone  → master service on Redis port 6379
  const endpoint = pulumi.output(
    architecture === "replication"
      ? `${helmReleaseName}-redis-headless.${CACHE_NAMESPACE}.svc.cluster.local`
      : `${helmReleaseName}-redis-master.${CACHE_NAMESPACE}.svc.cluster.local`
  );

  const port = pulumi.output(
    architecture === "replication" ? SENTINEL_PORT : REDIS_PORT
  );

  // Bitnami creates a secret named `{releaseName}-redis` with key `redis-password`
  const secretRef = {
    path: `${helmReleaseName}-redis`,
    key: "redis-password",
  };

  return {
    name,
    cloud,
    engine: config.engine,
    endpoint,
    port,
    secretRef,
    nativeResource: release,
  };
}
