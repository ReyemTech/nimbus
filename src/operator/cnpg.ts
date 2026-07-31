/**
 * CloudNativePG backend — provisions PostgreSQL clusters via the CNPG operator.
 *
 * Creates a CNPG Cluster CRD, backup credentials, and scheduled backups.
 * Returns IClusterInstance with createDatabase() for provisioning individual
 * databases with connection secrets replicated to target namespaces.
 *
 * @module operator/cnpg
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ensureNamespace } from "../utils/ensure-namespace";
import { resolveStorageTier, type StorageTierMap } from "../types/storage-tiers";
import type {
  IBackupDefaults,
  IOperatorClusterConfig,
  IClusterInstance,
  IOperatorDatabaseConfig,
  IDatabaseInstance,
} from "./interfaces";
import { createCnpgClusterDashboard } from "../observability/dashboards";
import { createPrometheusRule } from "../observability/alerts";
import { nimbus } from "../nimbus";
import {
  CNPG_API_VERSION,
  DATA_NAMESPACE,
  DEFAULT_PG_VERSION,
  createCnpgRoleRegistry,
} from "./cnpg-common.js";
import { createSingleCnpgDatabaseInstance } from "./cnpg-database.js";

const DEFAULT_REPLICAS = 1;
const DEFAULT_STORAGE_GB = 10;

/**
 * Create a single PostgreSQL cluster via the CloudNativePG operator (no environment awareness).
 */
function createSingleCnpgCluster(
  name: string,
  config: Omit<IOperatorClusterConfig, "environments"> | undefined,
  backupDefaults: IBackupDefaults | undefined,
  provider: k8s.Provider,
  operatorRelease: k8s.helm.v3.Release,
  storageTiers?: StorageTierMap
): IClusterInstance {
  const namespace = ensureNamespace(DATA_NAMESPACE, provider);
  const version = config?.version ?? DEFAULT_PG_VERSION;
  const replicas = config?.replicas ?? DEFAULT_REPLICAS;
  const storageGb = config?.storageGb ?? DEFAULT_STORAGE_GB;
  const superuserAccess = config?.superuserAccess ?? false;

  // Merge backup: per-cluster config overrides operator defaults
  const backup: IBackupDefaults | undefined =
    config?.backup?.target !== undefined
      ? { ...backupDefaults, ...(config.backup as IBackupDefaults) }
      : backupDefaults;

  const dependsOn: pulumi.Resource[] = [operatorRelease, namespace];

  // Create backup credentials Secret if backup is configured
  let backupSecret: k8s.core.v1.Secret | undefined;
  if (backup) {
    backupSecret = new k8s.core.v1.Secret(
      `${name}-cnpg-backup-secret`,
      {
        metadata: {
          name: `${name}-backup-s3-credentials`,
          namespace: DATA_NAMESPACE,
        },
        stringData: {
          ACCESS_KEY_ID: backup.target.credentials.accessKeyId,
          SECRET_ACCESS_KEY: backup.target.credentials.secretAccessKey,
          REGION: backup.target.region,
        },
      },
      { provider, dependsOn: [namespace] }
    );
    dependsOn.push(backupSecret);
  }

  // Build CNPG Cluster CRD spec
  const clusterSpec: Record<string, unknown> = {
    instances: replicas,
    imageName: `ghcr.io/cloudnative-pg/postgresql:${version}`,
    // Off by default: databases and roles are provisioned by the operator's own
    // Database/DatabaseRole controllers, which run inside the instance manager
    // and never authenticate over the network as `postgres`.
    enableSuperuserAccess: superuserAccess,
    postgresql: {
      parameters: config?.parameters ?? {},
    },
    storage: {
      size: `${storageGb}Gi`,
      // Only set storageClass if explicitly requested — CNPG uses the cluster
      // default (ssd) which is correct for the performance tier.
      ...(config?.storageTier && resolveStorageTier(config.storageTier, storageTiers)
        ? { storageClass: resolveStorageTier(config.storageTier, storageTiers) }
        : {}),
    },
  };

  if (config?.resources) {
    clusterSpec["resources"] = config.resources;
  }

  if (backup && backupSecret) {
    clusterSpec["backup"] = {
      retentionPolicy: backup.retentionDays ? `${backup.retentionDays}d` : "30d",
      barmanObjectStore: {
        destinationPath: backup.target.bucket.apply((b) => `s3://${b}/${name}`),
        s3Credentials: {
          accessKeyId: {
            name: backupSecret.metadata.name,
            key: "ACCESS_KEY_ID",
          },
          secretAccessKey: {
            name: backupSecret.metadata.name,
            key: "SECRET_ACCESS_KEY",
          },
          region: {
            name: backupSecret.metadata.name,
            key: "REGION",
          },
        },
        wal: backup.pitr
          ? {
              compression: "gzip",
              maxParallel: 8,
            }
          : undefined,
        data: {
          compression: "gzip",
        },
      },
    };
  }

  // CNPG Cluster CRD
  const cluster = new k8s.apiextensions.CustomResource(
    `${name}-cnpg-cluster`,
    {
      apiVersion: CNPG_API_VERSION,
      kind: "Cluster",
      metadata: {
        name,
        namespace: DATA_NAMESPACE,
        labels: config?.tags ?? {},
      },
      spec: clusterSpec,
    },
    { provider, dependsOn }
  );

  // Per-cluster Grafana dashboard
  createCnpgClusterDashboard(name, "observability", provider, [cluster]);

  // Per-cluster alert rules
  const fc = `cluster="${name}"`;
  createPrometheusRule(
    `${name}-cnpg-alerts`,
    "observability",
    [
      {
        name: `nimbus.cnpg.${name}`,
        rules: [
          {
            alert: "CnpgClusterDown",
            expr: `cnpg_collector_up{${fc}} == 0`,
            for: "2m",
            labels: { severity: "critical" },
            annotations: { summary: `CNPG cluster ${name} is DOWN` },
          },
          {
            alert: "CnpgReplicationLagCritical",
            expr: `cnpg_pg_replication_lag{${fc}} > 120`,
            for: "5m",
            labels: { severity: "critical" },
            annotations: { summary: `CNPG replication lag on ${name} is {{ $value }}s` },
          },
          {
            alert: "CnpgBackupStaleCritical",
            expr: `(time() - cnpg_collector_last_available_backup_timestamp{${fc}}) > 172800`,
            for: "10m",
            labels: { severity: "critical" },
            annotations: { summary: `CNPG backup for ${name} is older than 48h` },
          },
        ],
      },
    ],
    provider,
    [cluster]
  );

  // ScheduledBackup CRD if backup is configured
  if (backup) {
    new k8s.apiextensions.CustomResource(
      `${name}-cnpg-scheduled-backup`,
      {
        apiVersion: CNPG_API_VERSION,
        kind: "ScheduledBackup",
        metadata: {
          name: `${name}-scheduled-backup`,
          namespace: DATA_NAMESPACE,
        },
        spec: {
          schedule: backup.schedule ?? "0 3 * * *",
          backupOwnerReference: "self",
          cluster: { name },
          immediate: false,
        },
      },
      { provider, dependsOn: [cluster] }
    );
  }

  const endpoint = pulumi.output(`${name}-rw.${DATA_NAMESPACE}.svc.cluster.local`);
  const port = pulumi.output(5432);

  // One registry per cluster, because that is the scope a PostgreSQL role
  // exists at. Every database created below shares it.
  const roleRegistry = createCnpgRoleRegistry(name);

  nimbus.register(name, {
    name,
    type: "database",
    namespace: DATA_NAMESPACE,
    endpoint,
    port: 5432,
    // CNPG only publishes {cluster}-superuser while superuser access is enabled.
    ...(superuserAccess
      ? {
          secretRef: {
            name: `${name}-superuser`,
            keys: { password: "password" },
          },
        }
      : {}),
    nativeResource: cluster,
  });

  return {
    name,
    engine: "postgresql",
    endpoint,
    port,
    nativeResource: cluster,
    createDatabase(dbName: string, dbConfig: IOperatorDatabaseConfig) {
      let result: IDatabaseInstance | Record<string, IDatabaseInstance>;
      if (dbConfig.environments) {
        const envResult: Record<string, IDatabaseInstance> = {};
        for (const [env, envOverrides] of Object.entries(dbConfig.environments)) {
          const { environments: _, ...baseConfig } = dbConfig;
          const mergedConfig: Omit<IOperatorDatabaseConfig, "environments"> = {
            ...baseConfig,
            ...envOverrides,
          };
          envResult[env] = createSingleCnpgDatabaseInstance({
            clusterName: name,
            dbName: `${dbName}-${env}`,
            config: mergedConfig,
            endpoint,
            port,
            pgVersion: version,
            cluster,
            roleRegistry,
            provider,
          });
        }
        result = envResult;
      } else {
        const { environments: _, ...cleanConfig } = dbConfig;
        result = createSingleCnpgDatabaseInstance({
          clusterName: name,
          dbName,
          config: cleanConfig,
          endpoint,
          port,
          pgVersion: version,
          cluster,
          roleRegistry,
          provider,
        });
      }
      // Runtime: environments → Record, otherwise → IDatabaseInstance.
      // Overload signatures on IClusterInstance narrow the type for callers.
      return result as IDatabaseInstance & Record<string, IDatabaseInstance>;
    },
  };
}

/**
 * Create a PostgreSQL cluster via the CloudNativePG operator.
 *
 * When `config.environments` is set, creates separate clusters per environment
 * with `{name}-{env}` naming and returns a Record of IClusterInstance.
 *
 * @returns IClusterInstance or Record<string, IClusterInstance> when environments is set
 */
export function createCnpgDatabase(
  name: string,
  config: IOperatorClusterConfig | undefined,
  backupDefaults: IBackupDefaults | undefined,
  provider: k8s.Provider,
  operatorRelease: k8s.helm.v3.Release,
  storageTiers?: StorageTierMap
): IClusterInstance | Record<string, IClusterInstance> {
  if (config?.environments) {
    const result: Record<string, IClusterInstance> = {};
    for (const [env, envOverrides] of Object.entries(config.environments)) {
      const { environments: _, ...baseConfig } = config;
      const mergedConfig: Omit<IOperatorClusterConfig, "environments"> = {
        ...baseConfig,
        ...envOverrides,
      };
      result[env] = createSingleCnpgCluster(
        `${name}-${env}`,
        mergedConfig,
        backupDefaults,
        provider,
        operatorRelease,
        storageTiers
      );
    }
    return result;
  }

  if (config) {
    const { environments: _, ...cleanConfig } = config;
    return createSingleCnpgCluster(
      name,
      cleanConfig,
      backupDefaults,
      provider,
      operatorRelease,
      storageTiers
    );
  }

  return createSingleCnpgCluster(
    name,
    config,
    backupDefaults,
    provider,
    operatorRelease,
    storageTiers
  );
}
