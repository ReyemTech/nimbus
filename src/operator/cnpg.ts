/**
 * CloudNativePG backend — provisions PostgreSQL clusters via the CNPG operator.
 *
 * Creates a CNPG Cluster CRD, backup credentials, and scheduled backups.
 * Returns IClusterInstance with createDatabase() for provisioning individual
 * databases with connection secrets replicated to target namespaces.
 *
 * @module operator/cnpg
 */

import * as crypto from "node:crypto";
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

const DATA_NAMESPACE = "data";
const DEFAULT_PG_VERSION = "17";
const DEFAULT_REPLICAS = 1;
const DEFAULT_STORAGE_GB = 10;

/**
 * Create a single database instance within a CNPG cluster.
 *
 * Creates a dedicated user with a random password, then runs a psql Job
 * against the cluster's superuser to CREATE DATABASE + CREATE ROLE + GRANT.
 * Connection secrets with the per-user credentials are replicated to target
 * namespaces.
 */
function createSingleCnpgDatabaseInstance(
  clusterName: string,
  dbName: string,
  dbConfig: Omit<IOperatorDatabaseConfig, "environments">,
  endpoint: pulumi.Output<string>,
  port: pulumi.Output<number>,
  cluster: k8s.apiextensions.CustomResource,
  provider: k8s.Provider
): IDatabaseInstance {
  const username = dbConfig.owner ?? dbName;
  const clusterSecretName = `${clusterName}-superuser`;
  const userSecretName = `${clusterName}-${dbName}-user`;

  // Generate a random password for the database user (deterministic per Pulumi resource)
  const generatedPassword = pulumi.secret(crypto.randomBytes(24).toString("base64url"));

  // Store user credentials in a Secret in the data namespace
  const userSecret = new k8s.core.v1.Secret(
    `${clusterName}-${dbName}-user-secret`,
    {
      metadata: {
        name: userSecretName,
        namespace: DATA_NAMESPACE,
        labels: {
          "app.kubernetes.io/managed-by": "nimbus",
          "nimbus/cluster": clusterName,
          "nimbus/database": dbName,
        },
      },
      stringData: {
        username,
        password: generatedPassword,
      },
    },
    { provider, dependsOn: [cluster] }
  );

  // Job: create database and user via psql against the CNPG superuser
  const jobName = `cnpg-init-db-${clusterName}-${dbName}`;
  const initJob = new k8s.batch.v1.Job(
    jobName,
    {
      metadata: {
        name: jobName,
        namespace: DATA_NAMESPACE,
        labels: {
          "app.kubernetes.io/managed-by": "nimbus",
          "nimbus/cluster": clusterName,
          "nimbus/database": dbName,
        },
      },
      spec: {
        ttlSecondsAfterFinished: 300,
        backoffLimit: 5,
        template: {
          metadata: {
            labels: { "nimbus/database": dbName },
          },
          spec: {
            restartPolicy: "Never",
            containers: [
              {
                name: "psql",
                image: `ghcr.io/cloudnative-pg/postgresql:${DEFAULT_PG_VERSION}`,
                command: [
                  "sh",
                  "-c",
                  [
                    // Create the role if it doesn't exist, then set password
                    `psql -h "$PGHOST" -U postgres -d postgres -c "DO \\$\\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN CREATE ROLE \\"$DB_USER\\" LOGIN; END IF; END \\$\\$;"`,
                    `psql -h "$PGHOST" -U postgres -d postgres -c "ALTER ROLE \\"$DB_USER\\" PASSWORD '$DB_PASSWORD';"`,
                    // Create the database if it doesn't exist
                    `psql -h "$PGHOST" -U postgres -d postgres -tc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1 || psql -h "$PGHOST" -U postgres -d postgres -c "CREATE DATABASE \\"$DB_NAME\\" OWNER \\"$DB_USER\\";"`,
                    // Grant all privileges
                    `psql -h "$PGHOST" -U postgres -d postgres -c "GRANT ALL PRIVILEGES ON DATABASE \\"$DB_NAME\\" TO \\"$DB_USER\\";"`,
                  ].join(" && "),
                ],
                env: [
                  {
                    name: "PGHOST",
                    value: endpoint,
                  },
                  {
                    // psql reads PGPASSWORD automatically for authentication
                    name: "PGPASSWORD",
                    valueFrom: {
                      secretKeyRef: { name: clusterSecretName, key: "password" },
                    },
                  },
                  {
                    name: "PGSSLMODE",
                    value: "require",
                  },
                  { name: "DB_NAME", value: dbName },
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
    { provider, dependsOn: [cluster, userSecret] }
  );

  // Replicate connection secrets with per-user credentials to target namespaces
  const secrets: Record<string, pulumi.Output<string>> = {};
  const dbHost = endpoint;
  const dbPort = port;

  for (const targetNs of dbConfig.namespaces) {
    const nsResource = ensureNamespace(targetNs, provider);
    const secretName = `${clusterName}-${dbName}-pg`;

    new k8s.core.v1.Secret(
      `${clusterName}-${dbName}-secret-${targetNs}`,
      {
        metadata: {
          name: secretName,
          namespace: targetNs,
          labels: {
            "app.kubernetes.io/managed-by": "nimbus",
            "nimbus/cluster": clusterName,
            "nimbus/database": dbName,
          },
        },
        stringData: {
          host: dbHost,
          port: dbPort.apply((p) => String(p)),
          username,
          password: generatedPassword,
          database: dbName,
          uri: pulumi
            .all([dbHost, dbPort, generatedPassword])
            .apply(
              ([h, p, pw]) => `postgresql://${username}:${pw}@${h}:${p}/${dbName}?sslmode=require`
            ),
        },
      },
      { provider, dependsOn: [initJob, nsResource] }
    );

    secrets[targetNs] = pulumi.output(secretName);
  }

  return {
    name: dbName,
    clusterName,
    host: endpoint,
    port,
    database: pulumi.output(dbName),
    secrets,
    nativeResource: initJob,
  };
}

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
    // Enable superuser access so createDatabase() Jobs can CREATE DATABASE/ROLE
    enableSuperuserAccess: true,
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

  // Per-cluster Grafana dashboard
  createCnpgClusterDashboard(name, "observability", provider, [cluster]);

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
          cluster: { name },
          immediate: false,
        },
      },
      { provider, dependsOn: [cluster] }
    );
  }

  const endpoint = pulumi.output(`${name}-rw.${DATA_NAMESPACE}.svc.cluster.local`);
  const port = pulumi.output(5432);

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
          envResult[env] = createSingleCnpgDatabaseInstance(
            `${name}`,
            `${dbName}-${env}`,
            mergedConfig,
            endpoint,
            port,
            cluster,
            provider
          );
        }
        result = envResult;
      } else {
        const { environments: _, ...cleanConfig } = dbConfig;
        result = createSingleCnpgDatabaseInstance(
          name,
          dbName,
          cleanConfig,
          endpoint,
          port,
          cluster,
          provider
        );
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
    return createSingleCnpgCluster(name, cleanConfig, backupDefaults, provider, operatorRelease, storageTiers);
  }

  return createSingleCnpgCluster(name, config, backupDefaults, provider, operatorRelease, storageTiers);
}
