/**
 * MariaDB Operator backend — provisions MariaDB databases via the MariaDB operator.
 *
 * Creates a MariaDB CRD, backup credentials Secret, and optionally a Backup CRD
 * for scheduled S3 backups.
 *
 * @module operator/mariadb
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IDatabase } from "../database";
import { ensureNamespace } from "../utils/ensure-namespace";
import type { IBackupDefaults, IOperatorDatabaseConfig } from "./interfaces";

const DATA_NAMESPACE = "data";
const DEFAULT_MARIADB_VERSION = "11";
const DEFAULT_REPLICAS = 1;
const DEFAULT_STORAGE_GB = 10;

/**
 * Create a MariaDB database via the MariaDB operator.
 *
 * @param name - Database name (CRD metadata name + service name prefix)
 * @param config - Per-database configuration
 * @param backupDefaults - Operator-level backup defaults (merged with per-db overrides)
 * @param provider - Kubernetes provider to use for resource creation
 * @param operatorRelease - MariaDB operator Helm release (used as dependency)
 * @returns IDatabase with endpoint pointing to the MariaDB service
 */
export function createMariadbDatabase(
  name: string,
  config: IOperatorDatabaseConfig | undefined,
  backupDefaults: IBackupDefaults | undefined,
  provider: k8s.Provider,
  operatorRelease: k8s.helm.v3.Release
): IDatabase {
  const namespace = ensureNamespace(DATA_NAMESPACE, provider);
  const version = config?.version ?? DEFAULT_MARIADB_VERSION;
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
      `${name}-mariadb-backup-secret`,
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

  // Build MariaDB CRD spec
  const mariadbSpec: Record<string, unknown> = {
    image: `mariadb:${version}`,
    rootPasswordSecretKeyRef: {
      name: `${name}-root`,
      key: "password",
      generate: true,
    },
    port: 3306,
    storage: {
      size: `${storageGb}Gi`,
    },
  };

  if (config?.resources) {
    mariadbSpec["resources"] = config.resources;
  }

  if (config?.parameters) {
    mariadbSpec["myCnf"] = Object.entries(config.parameters)
      .map(([k, v]) => `${k} = ${v}`)
      .join("\n");
  }

  // Multi-replica replication config
  if (replicas > 1) {
    mariadbSpec["replicas"] = replicas;
    mariadbSpec["replication"] = {
      enabled: true,
      primary: {
        podDisruptionBudget: {
          enabled: true,
        },
        automaticFailover: true,
      },
    };
  }

  // MariaDB CRD
  const mariadb = new k8s.apiextensions.CustomResource(
    `${name}-mariadb`,
    {
      apiVersion: "k8s.mariadb.com/v1alpha1",
      kind: "MariaDB",
      metadata: {
        name,
        namespace: DATA_NAMESPACE,
        labels: config?.tags ?? {},
      },
      spec: mariadbSpec,
    },
    { provider, dependsOn }
  );

  // Backup CRD if backup is configured
  if (backup && backupSecret) {
    new k8s.apiextensions.CustomResource(
      `${name}-mariadb-backup`,
      {
        apiVersion: "k8s.mariadb.com/v1alpha1",
        kind: "Backup",
        metadata: {
          name: `${name}-backup`,
          namespace: DATA_NAMESPACE,
        },
        spec: {
          mariaDbRef: {
            name,
          },
          schedule: {
            cron: backup.schedule ?? "0 3 * * *",
            suspend: false,
          },
          maxRetention: backup.retentionDays ? `${backup.retentionDays * 24}h` : "720h",
          storage: {
            s3: {
              bucket: backup.target.bucket,
              prefix: name,
              endpoint: pulumi.output(`s3.${backup.target.region}.amazonaws.com`),
              region: backup.target.region,
              accessKeyIdSecretKeyRef: {
                name: backupSecret.metadata.name,
                key: "ACCESS_KEY_ID",
              },
              secretAccessKeySecretKeyRef: {
                name: backupSecret.metadata.name,
                key: "SECRET_ACCESS_KEY",
              },
            },
          },
        },
      },
      { provider, dependsOn: [mariadb, backupSecret] }
    );
  }

  return {
    name,
    cloud: { provider: "aws", region: backup?.target.region ?? "us-east-1" },
    engine: "mariadb",
    mode: "operator",
    endpoint: pulumi.output(`${name}.${DATA_NAMESPACE}.svc.cluster.local`),
    port: pulumi.output(3306),
    secretRef: {
      path: `${name}-root`,
      key: "password",
    },
    nativeResource: mariadb,
  };
}
