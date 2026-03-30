/**
 * Neo4j backend — deploys Neo4j via the official Helm chart
 * (helm.neo4j.com/neo4j) with full operator-level lifecycle management:
 *
 * - Scheduled S3 backups via CronJob (neo4j-admin database dump + aws s3 cp)
 * - Prometheus metrics via ServiceMonitor
 * - User provisioning via cypher-shell Jobs
 * - Connection secret replication to target namespaces
 *
 * Neo4j Community supports a single user database. Enterprise
 * supports multiple databases. User provisioning works on both.
 *
 * @module operator/neo4j
 */

import * as crypto from "node:crypto";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ensureNamespace } from "../utils/ensure-namespace";
import { resolveStorageTier, type StorageTierMap } from "../types/storage-tiers";
import type {
  IBackupDefaults,
  IOperatorDatabaseConfig,
  IDatabaseInstance,
  IClusterInstance,
} from "./interfaces";
import { createNeo4jClusterDashboard } from "../observability/dashboards";

const DATA_NAMESPACE = "data";
const NEO4J_BOLT_PORT = 7687;
const NEO4J_HTTP_PORT = 7474;
const NEO4J_METRICS_PORT = 2004;

/** Neo4j-specific cluster config. */
export interface INeo4jClusterConfig {
  /** Neo4j password for the built-in neo4j user. Auto-generated if omitted. */
  readonly password?: pulumi.Input<string>;
  /** Storage size in GB. Default: 10. */
  readonly storageGb?: number;
  /** Storage performance tier. Default: "performance". */
  readonly storageTier?: import("../types/storage-tiers").StorageTier;
  /** CPU and memory resource requests. */
  readonly resources?: {
    readonly cpu?: string;
    readonly memory?: string;
  };
  /** Enable APOC plugin. Default: true. */
  readonly apoc?: boolean;
  /** Enable Prometheus metrics endpoint. Default: true. */
  readonly metrics?: boolean;
  /** Additional neo4j.conf settings. */
  readonly config?: Record<string, string>;
  /** Additional Helm values to merge. */
  readonly values?: Record<string, unknown>;
}

/**
 * Build Neo4j Helm values from config.
 */
function buildNeo4jHelmValues(
  name: string,
  config: INeo4jClusterConfig | undefined,
  storageTiers?: StorageTierMap
): Record<string, unknown> {
  const storageGb = config?.storageGb ?? 10;
  const cpu = config?.resources?.cpu ?? "1";
  const memory = config?.resources?.memory ?? "4Gi";
  const storageClass = resolveStorageTier(config?.storageTier ?? "performance", storageTiers);
  const metricsEnabled = config?.metrics !== false;

  const neo4jConfig: Record<string, string> = {
    "server.memory.heap.initial_size": "2G",
    "server.memory.pagecache.size": "1G",
    ...(config?.config ?? {}),
  };

  // Enable Prometheus metrics endpoint. This is Enterprise-only but harmless
  // on Community (the config is accepted but the endpoint doesn't activate).
  // On Enterprise, it exposes metrics at :2004/metrics.
  if (metricsEnabled) {
    neo4jConfig["server.metrics.prometheus.enabled"] = "true";
    neo4jConfig["server.metrics.prometheus.endpoint"] = `0.0.0.0:${NEO4J_METRICS_PORT}`;
    neo4jConfig["server.metrics.filter"] = "*";
  }

  const values: Record<string, unknown> = {
    neo4j: {
      name,
      resources: { cpu, memory },
    },
    volumes: {
      data: {
        mode: "dynamic",
        dynamic: {
          ...(storageClass ? { storageClassName: storageClass } : {}),
          requests: { storage: `${storageGb}Gi` },
        },
      },
    },
    config: neo4jConfig,
    // Default to ClusterIP (no public exposure)
    services: { default: { type: "ClusterIP" } },
  };

  if (config?.apoc !== false) {
    (values as Record<string, Record<string, unknown>>)["apoc_config"] = {
      "apoc.trigger.enabled": "true",
      "apoc.import.file.enabled": "true",
    };
  }

  // Use chart's built-in ServiceMonitor (works with Enterprise metrics endpoint)
  if (metricsEnabled) {
    values["serviceMonitor"] = {
      enabled: true,
      labels: { release: "reyemtech-kube-prometheus-stack" },
      port: String(NEO4J_METRICS_PORT),
      path: "/metrics",
      interval: "30s",
    };
  }

  return { ...values, ...(config?.values ?? {}) };
}

/**
 * Create a Neo4j graph database cluster via the official Helm chart.
 *
 * Provides full operator-level lifecycle: deployment, backup, monitoring,
 * user provisioning, and connection secret replication.
 */
export function createNeo4jCluster(
  name: string,
  config: INeo4jClusterConfig | undefined,
  backupDefaults: IBackupDefaults | undefined,
  provider: k8s.Provider,
  operatorRelease: k8s.helm.v3.Release,
  storageTiers?: StorageTierMap
): IClusterInstance {
  const namespace = ensureNamespace(DATA_NAMESPACE, provider);
  const neo4jPassword = config?.password
    ? pulumi.output(config.password)
    : pulumi.secret(crypto.randomBytes(24).toString("base64url"));

  // -------------------------------------------------------------------------
  // 1. Admin credentials Secret
  // -------------------------------------------------------------------------
  const passwordSecretName = `${name}-neo4j-auth`;
  const passwordSecret = new k8s.core.v1.Secret(
    `${name}-neo4j-auth`,
    {
      metadata: {
        name: passwordSecretName,
        namespace: DATA_NAMESPACE,
        labels: { "app.kubernetes.io/managed-by": "nimbus" },
      },
      stringData: {
        NEO4J_AUTH: pulumi.interpolate`neo4j/${neo4jPassword}`,
        password: neo4jPassword,
      },
    },
    { provider, dependsOn: [namespace, operatorRelease], ignoreChanges: ["data", "stringData"] }
  );

  // -------------------------------------------------------------------------
  // 2. Helm deployment
  // -------------------------------------------------------------------------
  const helmValues = buildNeo4jHelmValues(name, config, storageTiers);
  const neo4jValues = (helmValues as Record<string, Record<string, unknown>>)["neo4j"] ?? {};
  neo4jValues["password"] = neo4jPassword;
  (helmValues as Record<string, unknown>)["neo4j"] = neo4jValues;

  const release = new k8s.helm.v3.Release(
    `${name}-neo4j`,
    {
      chart: "neo4j",
      repositoryOpts: { repo: "https://helm.neo4j.com/neo4j" },
      namespace: DATA_NAMESPACE,
      createNamespace: false,
      values: helmValues,
    },
    { provider, dependsOn: [namespace, operatorRelease, passwordSecret] }
  );

  const releaseName = release.status.apply((s) => s?.name ?? `${name}-neo4j`);
  const endpoint = releaseName.apply(
    (rn) => `${rn}.${DATA_NAMESPACE}.svc.cluster.local`
  );
  const port = pulumi.output(NEO4J_BOLT_PORT);

  // -------------------------------------------------------------------------
  // 3. Scheduled backups via CronJob (neo4j-admin dump → S3)
  // -------------------------------------------------------------------------
  if (backupDefaults) {
    const backupSchedule = backupDefaults.schedule ?? "0 3 * * *";
    const retentionDays = backupDefaults.retentionDays ?? 7;

    // Backup S3 credentials Secret
    const backupCredsName = `${name}-neo4j-backup-s3`;
    new k8s.core.v1.Secret(
      `${name}-neo4j-backup-creds`,
      {
        metadata: {
          name: backupCredsName,
          namespace: DATA_NAMESPACE,
          labels: { "app.kubernetes.io/managed-by": "nimbus" },
        },
        stringData: {
          AWS_ACCESS_KEY_ID: backupDefaults.target.credentials.accessKeyId,
          AWS_SECRET_ACCESS_KEY: backupDefaults.target.credentials.secretAccessKey,
          AWS_DEFAULT_REGION: backupDefaults.target.region,
        },
      },
      { provider, dependsOn: [namespace] }
    );

    // CronJob: dump neo4j database → upload to S3
    new k8s.batch.v1.CronJob(
      `${name}-neo4j-backup`,
      {
        metadata: {
          name: `${name}-neo4j-backup`,
          namespace: DATA_NAMESPACE,
          labels: { "app.kubernetes.io/managed-by": "nimbus" },
        },
        spec: {
          schedule: backupSchedule,
          concurrencyPolicy: "Forbid",
          successfulJobsHistoryLimit: 3,
          failedJobsHistoryLimit: 3,
          jobTemplate: {
            spec: {
              ttlSecondsAfterFinished: 86400,
              backoffLimit: 2,
              template: {
                metadata: {
                  labels: {
                    "app.kubernetes.io/managed-by": "nimbus",
                    "nimbus/cluster": name,
                    "nimbus/backup": "neo4j",
                  },
                },
                spec: {
                  restartPolicy: "Never",
                  containers: [
                    {
                      name: "neo4j-backup",
                      image: "neo4j:community",
                      command: [
                        "sh",
                        "-c",
                        [
                          // Generate timestamped dump filename
                          `TIMESTAMP=$(date +%Y%m%d-%H%M%S)`,
                          `DUMP_FILE="/tmp/${name}-neo4j-\${TIMESTAMP}.dump"`,
                          `S3_PATH="s3://$BACKUP_BUCKET/neo4j/${name}/\${TIMESTAMP}.dump"`,
                          // Stop accepting new transactions and dump
                          `neo4j-admin database dump neo4j --to-path=/tmp --overwrite-destination=true`,
                          // Rename to timestamped name
                          `mv /tmp/neo4j.dump "\${DUMP_FILE}"`,
                          // Install AWS CLI (minimal)
                          `apt-get update -qq && apt-get install -y -qq python3-pip > /dev/null 2>&1`,
                          `pip3 install -q awscli`,
                          // Upload to S3
                          `aws s3 cp "\${DUMP_FILE}" "\${S3_PATH}"`,
                          // Clean up old backups (retention)
                          `aws s3 ls "s3://$BACKUP_BUCKET/neo4j/${name}/" | while read -r line; do`,
                          `  file_date=$(echo "$line" | awk '{print $1}')`,
                          `  file_name=$(echo "$line" | awk '{print $4}')`,
                          `  if [ -n "$file_date" ] && [ -n "$file_name" ]; then`,
                          `    days_old=$(( ($(date +%s) - $(date -d "$file_date" +%s 2>/dev/null || echo 0)) / 86400 ))`,
                          `    if [ "$days_old" -gt "${retentionDays}" ]; then`,
                          `      aws s3 rm "s3://$BACKUP_BUCKET/neo4j/${name}/$file_name"`,
                          `    fi`,
                          `  fi`,
                          `done || true`,
                          `echo "Backup complete: \${S3_PATH}"`,
                        ].join("\n"),
                      ],
                      env: [
                        {
                          name: "BACKUP_BUCKET",
                          value: backupDefaults.target.bucket,
                        },
                        {
                          name: "NEO4J_ADMIN_PASSWORD",
                          valueFrom: {
                            secretKeyRef: { name: passwordSecretName, key: "password" },
                          },
                        },
                      ],
                      envFrom: [
                        { secretRef: { name: backupCredsName } },
                      ],
                      volumeMounts: [
                        {
                          name: "data",
                          mountPath: "/data",
                          readOnly: true,
                        },
                      ],
                    },
                  ],
                  // Mount the Neo4j data PVC for offline dump
                  volumes: [
                    {
                      name: "data",
                      persistentVolumeClaim: {
                        claimName: releaseName.apply((rn) => `data-${rn}-0`),
                        readOnly: true,
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
      { provider, dependsOn: [release] }
    );
  }

  // -------------------------------------------------------------------------
  // 4. Per-cluster Grafana dashboard
  // -------------------------------------------------------------------------
  createNeo4jClusterDashboard(name, "observability", provider, [release]);

  // -------------------------------------------------------------------------
  // 6. Return IClusterInstance with createDatabase()
  // -------------------------------------------------------------------------
  return {
    name,
    engine: "neo4j" as const,
    endpoint,
    port,
    nativeResource: release,

    createDatabase(dbName: string, dbConfig: IOperatorDatabaseConfig): IDatabaseInstance & Record<string, IDatabaseInstance> {
      const username = dbConfig.owner ?? dbName;
      const userSecretName = `${name}-${dbName}-neo4j-user`;

      // Generate per-database user password
      const userPassword = pulumi.secret(crypto.randomBytes(24).toString("base64url"));
      const userPasswordSecret = new k8s.core.v1.Secret(
        `${name}-${dbName}-neo4j-password`,
        {
          metadata: {
            name: userSecretName,
            namespace: DATA_NAMESPACE,
            labels: {
              "app.kubernetes.io/managed-by": "nimbus",
              "nimbus/cluster": name,
              "nimbus/database": dbName,
            },
          },
          stringData: { username, password: userPassword },
        },
        { provider, dependsOn: [release], ignoreChanges: ["data", "stringData"] }
      );

      // Read stored password for stability across deploys
      const storedUserSecret = k8s.core.v1.Secret.get(
        `${name}-${dbName}-neo4j-user-read`,
        pulumi.interpolate`${DATA_NAMESPACE}/${userSecretName}`,
        { provider, dependsOn: [userPasswordSecret] }
      );
      const stablePassword = storedUserSecret.data.apply((d) =>
        Buffer.from(d?.["password"] ?? "", "base64").toString()
      );

      // Job: create user via cypher-shell
      const jobName = `neo4j-init-user-${name}-${dbName}`;
      const initJob = new k8s.batch.v1.Job(
        jobName,
        {
          metadata: {
            name: jobName,
            namespace: DATA_NAMESPACE,
            labels: {
              "app.kubernetes.io/managed-by": "nimbus",
              "nimbus/cluster": name,
              "nimbus/database": dbName,
            },
          },
          spec: {
            ttlSecondsAfterFinished: 300,
            backoffLimit: 5,
            template: {
              metadata: { labels: { "nimbus/database": dbName } },
              spec: {
                restartPolicy: "Never",
                containers: [
                  {
                    name: "cypher-shell",
                    image: "neo4j:community",
                    command: [
                      "sh",
                      "-c",
                      [
                        `cypher-shell -a "bolt://$NEO4J_HOST:${NEO4J_BOLT_PORT}" -u neo4j -p "$NEO4J_ADMIN_PASSWORD" "CREATE USER \\\`$DB_USER\\\` IF NOT EXISTS SET PLAINTEXT PASSWORD '$DB_PASSWORD' SET PASSWORD CHANGE NOT REQUIRED"`,
                        // GRANT ROLE is Enterprise-only; gracefully skip on Community
                        `cypher-shell -a "bolt://$NEO4J_HOST:${NEO4J_BOLT_PORT}" -u neo4j -p "$NEO4J_ADMIN_PASSWORD" "GRANT ROLE reader, editor TO \\\`$DB_USER\\\`" || true`,
                      ].join(" && "),
                    ],
                    env: [
                      { name: "NEO4J_HOST", value: endpoint },
                      {
                        name: "NEO4J_ADMIN_PASSWORD",
                        valueFrom: {
                          secretKeyRef: { name: passwordSecretName, key: "password" },
                        },
                      },
                      { name: "DB_USER", value: username },
                      {
                        name: "DB_PASSWORD",
                        valueFrom: {
                          secretKeyRef: { name: userSecretName, key: "password" },
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
        { provider, dependsOn: [release, userPasswordSecret] }
      );

      // Replicate connection secrets to target namespaces
      const secrets: Record<string, pulumi.Output<string>> = {};

      for (const targetNs of dbConfig.namespaces) {
        const nsResource = ensureNamespace(targetNs, provider);
        const secretName = `${name}-${dbName}-neo4j`;

        new k8s.core.v1.Secret(
          `${name}-${dbName}-neo4j-secret-${targetNs}`,
          {
            metadata: {
              name: secretName,
              namespace: targetNs,
              labels: {
                "app.kubernetes.io/managed-by": "nimbus",
                "nimbus/cluster": name,
                "nimbus/database": dbName,
              },
            },
            stringData: {
              host: endpoint,
              port: String(NEO4J_BOLT_PORT),
              httpPort: String(NEO4J_HTTP_PORT),
              username,
              password: stablePassword,
              database: dbName,
              uri: pulumi
                .all([endpoint, stablePassword])
                .apply(
                  ([h, pw]) =>
                    `bolt://${username}:${pw}@${h}:${NEO4J_BOLT_PORT}`
                ),
            },
          },
          { provider, dependsOn: [initJob, nsResource] }
        );

        secrets[targetNs] = pulumi.output(secretName);
      }

      return {
        name: dbName,
        clusterName: name,
        host: endpoint,
        port,
        database: pulumi.output(dbName),
        secrets,
        nativeResource: initJob,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any;
    },
  };
}
