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
  ReclaimPolicy,
} from "./interfaces";
import { createCnpgClusterDashboard } from "../observability/dashboards";
import { createPrometheusRule } from "../observability/alerts";
import { nimbus } from "../nimbus";

const DATA_NAMESPACE = "data";
const DEFAULT_PG_VERSION = "17";
const DEFAULT_REPLICAS = 1;
const DEFAULT_STORAGE_GB = 10;
const CNPG_API_VERSION = "postgresql.cnpg.io/v1";
/** CNPG reads role passwords from Secrets of this type (username + password keys). */
const BASIC_AUTH_SECRET_TYPE = "kubernetes.io/basic-auth";
const DEFAULT_RECLAIM_POLICY: ReclaimPolicy = "retain";

/**
 * Normalize a string into a DNS-1123 subdomain usable as `metadata.name`.
 *
 * Only the Kubernetes object name is sanitized — the PostgreSQL identifiers in
 * `spec.name` / `spec.owner` are passed through verbatim so that CRs adopt
 * databases and roles that already exist under their original names.
 */
function toResourceName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Create a single database instance within a CNPG cluster.
 *
 * Provisioning is declarative: a `DatabaseRole` CR owns the login role and its
 * password, and a `Database` CR owns the database and its ownership. The
 * operator reconciles both continuously, so drift (a dropped role, a changed
 * owner) is corrected rather than silently persisting.
 *
 * Both CRs adopt pre-existing objects — CNPG detects the database/role and
 * `ALTER`s it to match the manifest instead of failing — so this is safe to
 * apply on top of databases previously created by the psql bootstrap Job.
 *
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
  const userSecretName = `${clusterName}-${dbName}-user`;
  const roleSecretName = `${clusterName}-${dbName}-role`;
  const reclaimPolicy = dbConfig.reclaimPolicy ?? DEFAULT_RECLAIM_POLICY;
  const resourceLabels = {
    "app.kubernetes.io/managed-by": "nimbus",
    "nimbus/cluster": clusterName,
    "nimbus/database": dbName,
  };

  // Generate a random password for the database user (deterministic per Pulumi resource)
  const generatedPassword = pulumi.secret(crypto.randomBytes(24).toString("base64url"));

  // Store user credentials in a Secret in the data namespace
  const userSecret = new k8s.core.v1.Secret(
    `${clusterName}-${dbName}-user-secret`,
    {
      metadata: {
        name: userSecretName,
        namespace: DATA_NAMESPACE,
        labels: resourceLabels,
      },
      stringData: {
        username,
        password: generatedPassword,
      },
    },
    { provider, dependsOn: [cluster], ignoreChanges: ["data", "stringData"] }
  );

  // Read password back from the stored secret (stable across deploys)
  const storedSecret = k8s.core.v1.Secret.get(
    `${clusterName}-${dbName}-user-secret-read`,
    pulumi.interpolate`${DATA_NAMESPACE}/${userSecretName}`,
    { provider, dependsOn: [userSecret] }
  );
  const stablePassword = storedSecret.data.apply((d) =>
    Buffer.from(d?.["password"] ?? "", "base64").toString()
  );

  // basic-auth projection of the same credentials — the only Secret shape the
  // CNPG DatabaseRole controller reads. Kept separate from userSecret because
  // Secret.type is immutable in Kubernetes: converting the existing Opaque
  // secret in place would force a replace and regenerate the password.
  const roleSecret = new k8s.core.v1.Secret(
    `${clusterName}-${dbName}-role-secret`,
    {
      metadata: {
        name: roleSecretName,
        namespace: DATA_NAMESPACE,
        labels: resourceLabels,
      },
      type: BASIC_AUTH_SECRET_TYPE,
      stringData: {
        username,
        password: stablePassword,
      },
    },
    { provider, dependsOn: [userSecret] }
  );

  // DatabaseRole CR: owns the login role and its password. Adopting an existing
  // role forces omitted attributes back to their defaults, so `login` is set
  // explicitly — everything else already matches the PostgreSQL defaults the
  // previous bootstrap Job left behind.
  const databaseRole = new k8s.apiextensions.CustomResource(
    `${clusterName}-${dbName}-role-cr`,
    {
      apiVersion: CNPG_API_VERSION,
      kind: "DatabaseRole",
      metadata: {
        name: toResourceName(`${clusterName}-${dbName}-role`),
        namespace: DATA_NAMESPACE,
        labels: resourceLabels,
      },
      spec: {
        cluster: { name: clusterName },
        name: username,
        ensure: "present",
        login: true,
        passwordSecret: { name: roleSecretName },
        databaseRoleReclaimPolicy: reclaimPolicy,
      },
    },
    { provider, dependsOn: [cluster, roleSecret] }
  );

  // Database CR: owns the database and its ownership. `spec.name` is the raw
  // PostgreSQL identifier so the CR adopts a database created under that exact
  // name; only metadata.name is sanitized for DNS-1123.
  const database = new k8s.apiextensions.CustomResource(
    `${clusterName}-${dbName}-database-cr`,
    {
      apiVersion: CNPG_API_VERSION,
      kind: "Database",
      metadata: {
        name: toResourceName(`${clusterName}-${dbName}-db`),
        namespace: DATA_NAMESPACE,
        labels: resourceLabels,
      },
      spec: {
        cluster: { name: clusterName },
        name: dbName,
        owner: username,
        ensure: "present",
        databaseReclaimPolicy: reclaimPolicy,
      },
    },
    // The owning role must exist before CREATE DATABASE ... OWNER.
    { provider, dependsOn: [cluster, databaseRole] }
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
          labels: resourceLabels,
        },
        stringData: {
          host: dbHost,
          port: dbPort.apply((p) => String(p)),
          username,
          password: stablePassword,
          database: dbName,
          uri: pulumi
            .all([dbHost, dbPort, stablePassword])
            .apply(
              ([h, p, pw]) => `postgresql://${username}:${pw}@${h}:${p}/${dbName}?sslmode=require`
            ),
        },
      },
      { provider, dependsOn: [database, nsResource] }
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
    nativeResource: database,
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
