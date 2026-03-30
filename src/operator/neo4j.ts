/**
 * Neo4j backend — deploys Neo4j via the official Helm chart
 * (helm.neo4j.com/neo4j) and provisions databases/users via
 * Kubernetes Jobs using cypher-shell.
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
  IOperatorDatabaseConfig,
  IDatabaseInstance,
  IClusterInstance,
} from "./interfaces";

const DATA_NAMESPACE = "data";
const NEO4J_BOLT_PORT = 7687;
const NEO4J_HTTP_PORT = 7474;

/** Neo4j-specific cluster config extending the base operator cluster config. */
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
  /** Additional neo4j.conf settings. */
  readonly config?: Record<string, string>;
  /** Additional Helm values to merge. */
  readonly values?: Record<string, unknown>;
}

/**
 * Build Neo4j Helm values from config.
 */
export function buildNeo4jHelmValues(
  name: string,
  config: INeo4jClusterConfig | undefined,
  storageTiers?: StorageTierMap
): Record<string, unknown> {
  const storageGb = config?.storageGb ?? 10;
  const cpu = config?.resources?.cpu ?? "1";
  const memory = config?.resources?.memory ?? "4Gi";
  const storageClass = resolveStorageTier(config?.storageTier ?? "performance", storageTiers);

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
    config: {
      "server.memory.heap.initial_size": "2G",
      "server.memory.pagecache.size": "1G",
      ...(config?.config ?? {}),
    },
  };

  if (config?.apoc !== false) {
    (values as Record<string, Record<string, unknown>>)["apoc_config"] = {
      "apoc.trigger.enabled": "true",
      "apoc.import.file.enabled": "true",
    };
  }

  // Default to ClusterIP (no public exposure)
  values["services"] = { default: { type: "ClusterIP" } };

  return { ...values, ...(config?.values ?? {}) };
}

/**
 * Create a Neo4j graph database cluster via the official Helm chart.
 *
 * Returns an IClusterInstance with createDatabase() for user provisioning
 * and connection secret replication to target namespaces.
 */
export function createNeo4jCluster(
  name: string,
  config: INeo4jClusterConfig | undefined,
  provider: k8s.Provider,
  operatorRelease: k8s.helm.v3.Release,
  storageTiers?: StorageTierMap
): IClusterInstance {
  const namespace = ensureNamespace(DATA_NAMESPACE, provider);
  const neo4jPassword = config?.password
    ? pulumi.output(config.password)
    : pulumi.secret(crypto.randomBytes(24).toString("base64url"));

  // Store the neo4j admin password
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
        // Neo4j Helm chart expects NEO4J_AUTH in "neo4j/<password>" format
        NEO4J_AUTH: pulumi.interpolate`neo4j/${neo4jPassword}`,
        password: neo4jPassword,
      },
    },
    { provider, dependsOn: [namespace, operatorRelease], ignoreChanges: ["data", "stringData"] }
  );

  const helmValues = buildNeo4jHelmValues(name, config, storageTiers);

  // Set password in Helm values
  const neo4jValues = (helmValues as Record<string, Record<string, unknown>>)["neo4j"] ?? {};
  neo4jValues["password"] = neo4jPassword;
  (helmValues as Record<string, unknown>)["neo4j"] = neo4jValues;

  // Deploy Neo4j via Helm
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

  // Neo4j service endpoint — Pulumi appends a hash suffix to the Helm release name.
  // Derive the actual service name from the release status.
  const releaseName = release.status.apply((s) => s?.name ?? `${name}-neo4j`);
  const endpoint = releaseName.apply(
    (rn) => `${rn}.${DATA_NAMESPACE}.svc.cluster.local`
  );
  const port = pulumi.output(NEO4J_BOLT_PORT);

  return {
    name,
    engine: "postgresql" as const, // Closest match in the union type — graph DB
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

      // Read stored password for stability
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
                        // Create user if not exists, set password
                        `cypher-shell -a "bolt://$NEO4J_HOST:${NEO4J_BOLT_PORT}" -u neo4j -p "$NEO4J_ADMIN_PASSWORD" "CREATE USER \\\`$DB_USER\\\` IF NOT EXISTS SET PLAINTEXT PASSWORD '$DB_PASSWORD' SET PASSWORD CHANGE NOT REQUIRED"`,
                        // Grant access roles
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
