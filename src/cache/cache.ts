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

  // Master-tracking service: a headless Service + Deployment that queries
  // Sentinel and patches the Endpoints to always point to the current master.
  // Apps connect to {name}-master.{ns}:6379 — no Sentinel client needed.
  if (architecture === "replication") {
    const masterSvcName = `${name}-master`;

    new k8s.core.v1.Service(
      `${name}-redis-master-svc`,
      {
        metadata: {
          name: masterSvcName,
          namespace: CACHE_NAMESPACE,
          labels: { "app.kubernetes.io/managed-by": "nimbus", "nimbus/cache": name },
        },
        spec: {
          type: "ClusterIP",
          ports: [{ port: REDIS_PORT, targetPort: REDIS_PORT, name: "redis" }],
          // No selector — Endpoints managed by the tracker
        },
      },
      { provider, dependsOn: [release, ns] }
    );

    // Tracker Deployment that runs a shell loop querying Sentinel every 10s.
    // Uses alpine:3 + apk redis/curl because bitnami/redis lacks curl.
    // Passes REDIS_PASSWORD for Sentinel auth and resolves hostname → IP
    // since K8s Endpoints require IP addresses, not DNS names.
    const trackerScript = actualReleaseName.apply((rn) =>
      [
        "#!/bin/sh",
        "set -e",
        "apk add --no-cache redis curl > /dev/null 2>&1",
        `SENTINEL="${rn}-headless.${CACHE_NAMESPACE}.svc.cluster.local"`,
        `SVC="${masterSvcName}"`,
        `NS="${CACHE_NAMESPACE}"`,
        `API=https://kubernetes.default.svc`,
        `CACERT=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`,
        'echo "tracker starting"',
        "while true; do",
        "  TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)",
        '  MASTER_HOST=$(redis-cli -h "$SENTINEL" -p 26379 -a "$REDIS_PASSWORD" --no-auth-warning SENTINEL get-master-addr-by-name mymaster 2>/dev/null | head -1)',
        '  if [ -n "$MASTER_HOST" ]; then',
        "    MASTER_IP=$(getent hosts \"$MASTER_HOST\" 2>/dev/null | awk '{print $1}' | head -1)",
        '    if [ -z "$MASTER_IP" ]; then',
        '      echo "$(date -Iseconds) dns-resolve-failed host=$MASTER_HOST"',
        "      sleep 10",
        "      continue",
        "    fi",
        `    PAYLOAD='{"apiVersion":"v1","kind":"Endpoints","metadata":{"name":"'$SVC'","namespace":"'$NS'"},"subsets":[{"addresses":[{"ip":"'$MASTER_IP'"}],"ports":[{"port":6379,"name":"redis","protocol":"TCP"}]}]}'`,
        '    HTTP_CODE=$(curl -sk -o /dev/null -w "%{http_code}" -X PUT "$API/api/v1/namespaces/$NS/endpoints/$SVC" \\',
        '      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --cacert "$CACERT" -d "$PAYLOAD")',
        '    if [ "$HTTP_CODE" = "404" ]; then',
        '      HTTP_CODE=$(curl -sk -o /dev/null -w "%{http_code}" -X POST "$API/api/v1/namespaces/$NS/endpoints" \\',
        '        -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --cacert "$CACERT" -d "$PAYLOAD")',
        '      echo "$(date -Iseconds) created master=$MASTER_IP http=$HTTP_CODE"',
        "    else",
        '      echo "$(date -Iseconds) master=$MASTER_IP http=$HTTP_CODE"',
        "    fi",
        "  else",
        '    echo "$(date -Iseconds) sentinel query failed"',
        "  fi",
        "  sleep 10",
        "done",
      ].join("\n")
    );

    new k8s.core.v1.ConfigMap(
      `${name}-redis-master-tracker-script`,
      {
        metadata: { name: `${name}-master-tracker`, namespace: CACHE_NAMESPACE },
        data: { "track.sh": trackerScript },
      },
      { provider, dependsOn: [ns] }
    );

    new k8s.apps.v1.Deployment(
      `${name}-redis-master-tracker`,
      {
        metadata: { name: `${name}-master-tracker`, namespace: CACHE_NAMESPACE },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: `${name}-master-tracker` } },
          template: {
            metadata: { labels: { app: `${name}-master-tracker` } },
            spec: {
              serviceAccountName: `${name}-master-tracker`,
              containers: [
                {
                  name: "tracker",
                  image: "alpine:3",
                  command: ["sh", "/scripts/track.sh"],
                  env: [
                    {
                      name: "REDIS_PASSWORD",
                      valueFrom: {
                        secretKeyRef: { name: actualReleaseName, key: "redis-password" },
                      },
                    },
                  ],
                  volumeMounts: [{ name: "script", mountPath: "/scripts" }],
                  resources: {
                    requests: { cpu: "10m", memory: "32Mi" },
                    limits: { cpu: "50m", memory: "64Mi" },
                  },
                },
              ],
              volumes: [{ name: "script", configMap: { name: `${name}-master-tracker` } }],
            },
          },
        },
      },
      { provider, dependsOn: [release, ns] }
    );

    new k8s.core.v1.ServiceAccount(
      `${name}-redis-master-tracker-sa`,
      { metadata: { name: `${name}-master-tracker`, namespace: CACHE_NAMESPACE } },
      { provider, dependsOn: [ns] }
    );

    new k8s.rbac.v1.Role(
      `${name}-redis-master-tracker-role`,
      {
        metadata: { name: `${name}-master-tracker`, namespace: CACHE_NAMESPACE },
        rules: [
          {
            apiGroups: [""],
            resources: ["endpoints"],
            verbs: ["get", "update", "patch", "create"],
          },
        ],
      },
      { provider }
    );

    new k8s.rbac.v1.RoleBinding(
      `${name}-redis-master-tracker-binding`,
      {
        metadata: { name: `${name}-master-tracker`, namespace: CACHE_NAMESPACE },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "Role",
          name: `${name}-master-tracker`,
        },
        subjects: [
          { kind: "ServiceAccount", name: `${name}-master-tracker`, namespace: CACHE_NAMESPACE },
        ],
      },
      { provider }
    );
  }

  // App-facing endpoint: the master-tracking service (always routes to master).
  // Falls back to the main ClusterIP service for standalone architecture.
  const endpoint =
    architecture === "replication"
      ? pulumi.output(`${name}-master.${CACHE_NAMESPACE}.svc.cluster.local`)
      : actualReleaseName.apply((rn) => `${rn}.${CACHE_NAMESPACE}.svc.cluster.local`);

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
            uri: pulumi
              .all([endpoint, password])
              .apply(([h, pw]) => `redis://:${pw}@${h}:${appPort}`),
            // Sentinel fields for failover-aware connections
            sentinel_host: actualReleaseName.apply(
              (rn) => `${rn}-headless.${CACHE_NAMESPACE}.svc.cluster.local`
            ),
            sentinel_port: String(SENTINEL_PORT),
            sentinel_service: "mymaster",
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
