/**
 * MariaDB Operator backend — provisions MariaDB instances via CRDs.
 *
 * Creates a MariaDB CRD and optional backup CRDs. Returns IClusterInstance
 * with createDatabase() for provisioning individual databases with connection
 * secrets replicated to target namespaces.
 *
 * @module operator/mariadb
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ensureNamespace } from "../utils/ensure-namespace";
import type { IBackupDefaults, IOperatorClusterConfig, IClusterInstance, IOperatorDatabaseConfig, IDatabaseInstance } from "./interfaces";

const DATA_NAMESPACE = "data";
const DEFAULT_MARIADB_VERSION = "11.7";
const DEFAULT_REPLICAS = 1;
const DEFAULT_STORAGE_GB = 10;

/**
 * Create a MariaDB instance via the MariaDB Operator.
 *
 * @returns IClusterInstance with createDatabase() for per-database provisioning
 */
export function createMariadbDatabase(
  name: string,
  config: IOperatorClusterConfig | undefined,
  backupDefaults: IBackupDefaults | undefined,
  provider: k8s.Provider,
  operatorRelease: k8s.helm.v3.Release
): IClusterInstance {
  const namespace = ensureNamespace(DATA_NAMESPACE, provider);
  const replicas = config?.replicas ?? DEFAULT_REPLICAS;
  const storageGb = config?.storageGb ?? DEFAULT_STORAGE_GB;
  const dbVersion = config?.version ?? DEFAULT_MARIADB_VERSION;
  const image = `mariadb:${dbVersion}`;

  // Merge backup: per-cluster config overrides operator defaults
  const backup: IBackupDefaults | undefined =
    config?.backup?.target !== undefined
      ? { ...backupDefaults, ...(config.backup as IBackupDefaults) }
      : backupDefaults;

  const dependsOn: pulumi.Resource[] = [operatorRelease, namespace];

  // MariaDB CRD spec
  const mariadbSpec: Record<string, unknown> = {
    image,
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
      .map(([k, v]) => `${k}=${v}`)
      .join("\n");
  }

  // Replication (replicas > 1)
  if (replicas > 1) {
    mariadbSpec["replicas"] = replicas;
    mariadbSpec["replication"] = {
      enabled: true,
      primary: { automaticFailover: true },
    };
  }

  // S3 backup credentials
  if (backup) {
    const backupSecret = new k8s.core.v1.Secret(
      `${name}-mariadb-backup-secret`,
      {
        metadata: {
          name: `${name}-backup-s3-credentials`,
          namespace: DATA_NAMESPACE,
        },
        stringData: {
          "access-key-id": backup.target.credentials.accessKeyId,
          "secret-access-key": backup.target.credentials.secretAccessKey,
        },
      },
      { provider, dependsOn: [namespace] }
    );
    dependsOn.push(backupSecret);
  }

  // Create the MariaDB CRD
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

  // Scheduled backup via S3
  if (backup) {
    new k8s.apiextensions.CustomResource(
      `${name}-mariadb-backup`,
      {
        apiVersion: "k8s.mariadb.com/v1alpha1",
        kind: "Backup",
        metadata: {
          name: `${name}-scheduled-backup`,
          namespace: DATA_NAMESPACE,
        },
        spec: {
          mariaDbRef: { name },
          schedule: {
            cron: backup.schedule ?? "0 3 * * *",
            suspend: false,
          },
          maxRetention: `${(backup.retentionDays ?? 7) * 24}h`,
          storage: {
            s3: {
              bucket: backup.target.bucket,
              prefix: `mariadb/${name}`,
              accessKeyIdSecretKeyRef: {
                name: `${name}-backup-s3-credentials`,
                key: "access-key-id",
              },
              secretAccessKeySecretKeyRef: {
                name: `${name}-backup-s3-credentials`,
                key: "secret-access-key",
              },
              region: backup.target.region,
            },
          },
        },
      },
      { provider, dependsOn: [mariadb] }
    );
  }

  const endpoint = pulumi.output(`${name}.${DATA_NAMESPACE}.svc.cluster.local`);
  const port = pulumi.output(3306);
  const rootSecretName = `${name}-root`;

  return {
    name,
    engine: "mariadb",
    endpoint,
    port,
    nativeResource: mariadb,
    createDatabase(dbName: string, dbConfig: IOperatorDatabaseConfig): IDatabaseInstance {
      const secrets: Record<string, pulumi.Output<string>> = {};

      // Read root password from the operator-generated secret
      const rootSecret = k8s.core.v1.Secret.get(
        `${name}-${dbName}-root-src`,
        pulumi.interpolate`${DATA_NAMESPACE}/${rootSecretName}`,
        { provider, dependsOn: [mariadb] }
      );

      const rootPassword = rootSecret.data.apply(
        (data) => Buffer.from(data?.["password"] ?? "", "base64").toString()
      );

      const username = dbConfig.owner ?? dbName;
      const dbHost = endpoint;
      const dbPort = port;

      for (const targetNs of dbConfig.namespaces) {
        const nsResource = ensureNamespace(targetNs, provider);
        const secretName = `${name}-${dbName}-mariadb`;

        new k8s.core.v1.Secret(
          `${name}-${dbName}-secret-${targetNs}`,
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
              host: dbHost,
              port: dbPort.apply((p) => String(p)),
              username,
              password: rootPassword,
              database: dbName,
              uri: pulumi.all([dbHost, dbPort, rootPassword]).apply(
                ([h, p, pw]) => `mysql://${username}:${pw}@${h}:${p}/${dbName}`
              ),
            },
          },
          { provider, dependsOn: [mariadb, nsResource] }
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
        nativeResource: mariadb,
      };
    },
  };
}
