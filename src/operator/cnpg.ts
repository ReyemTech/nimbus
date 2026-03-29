/**
 * CloudNativePG backend — provisions PostgreSQL databases via the CNPG operator.
 *
 * Creates a CNPG Cluster CRD, backup credentials Secret, and optionally a
 * ScheduledBackup CRD for automated S3 backups with WAL archiving for PITR.
 *
 * @module operator/cnpg
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IDatabase } from "../database";
import { ensureNamespace } from "../utils/ensure-namespace";
import type { IBackupDefaults, IOperatorDatabaseConfig } from "./interfaces";

const DATA_NAMESPACE = "data";
const DEFAULT_PG_VERSION = "16";
const DEFAULT_REPLICAS = 1;
const DEFAULT_STORAGE_GB = 10;

/**
 * Create a PostgreSQL database via the CloudNativePG operator.
 *
 * @param name - Database name (CRD metadata name + service name prefix)
 * @param config - Per-database configuration
 * @param backupDefaults - Operator-level backup defaults (merged with per-db overrides)
 * @param provider - Kubernetes provider to use for resource creation
 * @param operatorRelease - CNPG operator Helm release (used as dependency)
 * @returns IDatabase with endpoint pointing to the CNPG read-write service
 */
export function createCnpgDatabase(
  name: string,
  config: IOperatorDatabaseConfig | undefined,
  backupDefaults: IBackupDefaults | undefined,
  provider: k8s.Provider,
  operatorRelease: k8s.helm.v3.Release
): IDatabase {
  const namespace = ensureNamespace(DATA_NAMESPACE, provider);
  const version = config?.version ?? DEFAULT_PG_VERSION;
  const replicas = config?.replicas ?? DEFAULT_REPLICAS;
  const storageGb = config?.storageGb ?? DEFAULT_STORAGE_GB;

  // Merge backup: per-db config overrides operator defaults
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
    postgresql: {
      parameters: config?.parameters ?? {},
    },
    storage: {
      size: `${storageGb}Gi`,
    },
  };

  if (config?.resources) {
    clusterSpec["resources"] = config.resources;
  }

  if (backup && backupSecret) {
    const pitrIntervalSeconds = backup.pitrIntervalSeconds ?? 300;

    clusterSpec["backup"] = {
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
              archiveTimeout: `${pitrIntervalSeconds}s`,
            }
          : undefined,
        data: {
          compression: "gzip",
        },
        retentionPolicy: backup.retentionDays ? `${backup.retentionDays}d` : "30d",
      },
    };
  }

  // CNPG Cluster CRD
  const cluster = new k8s.apiextensions.CustomResource(
    `${name}-cnpg-cluster`,
    {
      apiVersion: "postgresql.cnpg.io/v1",
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

  // ScheduledBackup CRD if backup is configured
  if (backup) {
    new k8s.apiextensions.CustomResource(
      `${name}-cnpg-scheduled-backup`,
      {
        apiVersion: "postgresql.cnpg.io/v1",
        kind: "ScheduledBackup",
        metadata: {
          name: `${name}-scheduled-backup`,
          namespace: DATA_NAMESPACE,
        },
        spec: {
          schedule: backup.schedule ?? "0 3 * * *",
          backupOwnerReference: "self",
          cluster: {
            name,
          },
          immediate: false,
        },
      },
      { provider, dependsOn: [cluster] }
    );
  }

  return {
    name,
    cloud: { provider: "aws", region: backup?.target.region ?? "us-east-1" },
    engine: "postgresql",
    mode: "operator",
    endpoint: pulumi.output(`${name}-rw.${DATA_NAMESPACE}.svc.cluster.local`),
    port: pulumi.output(5432),
    secretRef: {
      path: `${name}-app`,
      key: "password",
    },
    nativeResource: cluster,
  };
}
