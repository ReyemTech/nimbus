/**
 * Operator module — Kubernetes operator deployment and resource provisioning.
 *
 * Supports CloudNativePG (PostgreSQL), MariaDB Operator, and MinIO via Helm.
 * Database operators expose createCluster() / createDatabase(); the MinIO
 * operator exposes createBucket() instead.
 *
 * @module operator
 */

import * as k8s from "@pulumi/kubernetes";
import { assertNever } from "../types";
import { ensureNamespace } from "../utils/ensure-namespace";
import { createCnpgDatabase } from "./cnpg";
import { createMariadbDatabase } from "./mariadb";
import { createMinioOperator } from "./minio";
import { createNeo4jCluster } from "./neo4j";
import type {
  IOperator,
  IMinIOOperator,
  IOperatorConfig,
  IOperatorClusterConfig,
  IClusterInstance,
  OperatorType,
} from "./interfaces";

export type {
  OperatorType,
  EnvironmentOverrides,
  IBackupDefaults,
  IOperatorConfig,
  IOperatorClusterConfig,
  IOperatorDatabaseConfig,
  IDatabaseInstance,
  IDatabaseGrant,
  IDatabaseRole,
  IDatabaseRoleConfig,
  ReclaimPolicy,
  IClusterInstance,
  IOperator,
  IMinIOOperator,
  IMinIOBucket,
  IMinIOBucketConfig,
  IMinIOIngressConfig,
} from "./interfaces";
export { OPERATOR_TYPES } from "./interfaces";
export { createMinioIngress } from "./minio";
export type { INeo4jClusterConfig } from "./neo4j";

const DATA_NAMESPACE = "data";

/** Helm chart metadata for each operator type. */
interface OperatorChartInfo {
  readonly repo: string;
  readonly chart: string;
  readonly defaultNamespace: string;
}

/** Separate CRDs chart (installed before the operator). */
interface OperatorCrdsInfo {
  readonly repo: string;
  readonly chart: string;
}

const OPERATOR_CHARTS: Record<OperatorType, OperatorChartInfo & { crds?: OperatorCrdsInfo }> = {
  "cloudnative-pg": {
    repo: "https://cloudnative-pg.github.io/charts",
    chart: "cloudnative-pg",
    defaultNamespace: "cnpg-system",
  },
  "mariadb-operator": {
    repo: "https://helm.mariadb.com/mariadb-operator",
    chart: "mariadb-operator",
    defaultNamespace: "mariadb-system",
    crds: {
      repo: "https://helm.mariadb.com/mariadb-operator",
      chart: "mariadb-operator-crds",
    },
  },
  minio: {
    repo: "https://operator.min.io",
    chart: "operator",
    defaultNamespace: "minio-operator",
  },
  neo4j: {
    // Neo4j has no separate operator — the Helm chart deploys the instance directly.
    // The operator release is a no-op; createCluster() deploys via its own Helm release.
    repo: "https://helm.neo4j.com/neo4j",
    chart: "neo4j",
    defaultNamespace: DATA_NAMESPACE,
  },
};

/**
 * Deploy an operator to a Kubernetes cluster.
 *
 * - `"cloudnative-pg"` / `"mariadb-operator"` → returns IOperator with createCluster()
 * - `"minio"` → returns IMinIOOperator with createBucket()
 *
 * @example Database operator
 * ```typescript
 * const op = createOperator("cloudnative-pg", {
 *   cluster,
 *   backup: {
 *     target: backupTarget,
 *     schedule: "0 3 * * *",
 *     retentionDays: 7,
 *     pitr: true,
 *   },
 * });
 * const cluster = op.createCluster("app-db", { replicas: 2, storageGb: 20 });
 * ```
 *
 * @example MinIO operator
 * ```typescript
 * const minio = createOperator("minio", { cluster }) as IMinIOOperator;
 * const bucket = minio.createBucket("uploads", { namespaces: ["app"] });
 * ```
 *
 * @param type - Operator type
 * @param config - Operator configuration
 * @returns Deployed IOperator or IMinIOOperator instance
 */
export function createOperator(type: "minio", config: IOperatorConfig): IMinIOOperator;
export function createOperator(
  type: "cloudnative-pg" | "mariadb-operator" | "neo4j",
  config: IOperatorConfig
): IOperator;
export function createOperator(
  type: OperatorType,
  config: IOperatorConfig
): IOperator | IMinIOOperator;
export function createOperator(
  type: OperatorType,
  config: IOperatorConfig
): IOperator | IMinIOOperator {
  const chartInfo = OPERATOR_CHARTS[type];
  const provider = config.cluster.provider;
  const namespace = config.namespace ?? chartInfo.defaultNamespace;

  // Ensure operator namespace exists
  const ns = ensureNamespace(namespace, provider);

  // Install CRDs first if the operator needs a separate CRDs chart
  const operatorDeps: k8s.helm.v3.Release[] = [];
  if (chartInfo.crds) {
    const crdsRelease = new k8s.helm.v3.Release(
      `${type}-crds`,
      {
        chart: chartInfo.crds.chart,
        repositoryOpts: { repo: chartInfo.crds.repo },
        namespace,
        createNamespace: false,
        values: {},
      },
      { provider, dependsOn: [ns] }
    );
    operatorDeps.push(crdsRelease);
  }

  // Neo4j has no separate operator — the Helm chart deploys the instance
  // directly. Skip the operator install; createCluster() deploys via its own
  // Helm release with instance-specific values.
  const skipOperatorInstall = type === "neo4j";

  const helmValues = config.values ?? {};

  // Deploy Helm release (operator chart)
  const helmRelease = skipOperatorInstall
    ? (ns as unknown as k8s.helm.v3.Release) // Placeholder — Neo4j deploys in createCluster()
    : new k8s.helm.v3.Release(
        `${type}-operator`,
        {
          chart: chartInfo.chart,
          repositoryOpts: { repo: chartInfo.repo },
          version: config.version,
          namespace,
          createNamespace: false,
          values: helmValues,
        },
        { provider, dependsOn: [ns, ...operatorDeps] }
      );

  // CNPG's admission webhooks ship with timeouts tuned for a control plane
  // co-located with the cluster: 10s mutating, 15s validating, both with
  // failurePolicy: Fail. On a hosted control plane — Rackspace Spot, for
  // instance, where the API server runs outside the cluster and every
  // admission call has to tunnel back in through konnectivity — that round
  // trip costs seconds rather than milliseconds.
  //
  // Measured on iad-1, ten consecutive mcluster.cnpg.io probes: 2.0s, 2.2s,
  // 3.0s, 3.1s, 3.4s, 4.7s, 6.5s, 7.2s, 7.8s, 10.2s. One in ten already
  // exceeded the 10s ceiling while the operator sat idle at 8 millicores, so
  // it is the network path that is slow, not the operator. Concurrent
  // admission — a Pulumi preview dry-running several resources at once —
  // pushes more of them over, and with failurePolicy: Fail that aborts the
  // run partway through an update.
  //
  // The chart exposes only webhook.{mutating,validating}.{create,failurePolicy},
  // not timeoutSeconds, so this cannot be expressed through Helm values. Patch
  // the field instead: `webhooks` is a listType=map keyed by `name`, so each
  // entry merges by key and no other field of the configuration is touched.
  // In particular failurePolicy stays Fail — nothing bypasses admission.
  if (type === "cloudnative-pg" && !skipOperatorInstall) {
    const webhookTimeoutSeconds = 30;

    new k8s.admissionregistration.v1.MutatingWebhookConfigurationPatch(
      `${type}-mutating-webhook-timeout`,
      {
        metadata: { name: "cnpg-mutating-webhook-configuration" },
        webhooks: [
          "mbackup.cnpg.io",
          "mcluster.cnpg.io",
          "mdatabase.cnpg.io",
          "mscheduledbackup.cnpg.io",
        ].map((name) => ({ name, timeoutSeconds: webhookTimeoutSeconds })),
      },
      { provider, dependsOn: [helmRelease], retainOnDelete: true }
    );

    new k8s.admissionregistration.v1.ValidatingWebhookConfigurationPatch(
      `${type}-validating-webhook-timeout`,
      {
        metadata: { name: "cnpg-validating-webhook-configuration" },
        webhooks: [
          "vbackup.cnpg.io",
          "vcluster.cnpg.io",
          "vdatabase.cnpg.io",
          "vpooler.cnpg.io",
          "vscheduledbackup.cnpg.io",
        ].map((name) => ({ name, timeoutSeconds: webhookTimeoutSeconds })),
      },
      { provider, dependsOn: [helmRelease], retainOnDelete: true }
    );
  }

  // MinIO returns a different operator shape (createBucket instead of createCluster)
  if (type === "minio") {
    return createMinioOperator(config, helmRelease);
  }

  return {
    name: type,
    type,
    helmRelease,
    createCluster(name: string, clusterConfig?: IOperatorClusterConfig) {
      let result: IClusterInstance | Record<string, IClusterInstance>;
      const tierMap = config.cluster.storageTiers;
      switch (type) {
        case "cloudnative-pg":
          result = createCnpgDatabase(
            name,
            clusterConfig,
            config.backup,
            provider,
            helmRelease,
            tierMap
          );
          break;
        case "mariadb-operator":
          result = createMariadbDatabase(
            name,
            clusterConfig,
            config.backup,
            provider,
            helmRelease,
            tierMap
          );
          break;
        case "neo4j":
          // Neo4j Helm chart deploys the instance directly (no CRD operator).
          // The helmRelease IS the Neo4j deployment; createCluster wraps it.
          result = createNeo4jCluster(
            name,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any -- neo4j config type narrowing handled at runtime
            clusterConfig as any,
            config.backup,
            provider,
            helmRelease,
            tierMap
          );
          break;
        default:
          return assertNever(type);
      }
      // Runtime: environments → Record, otherwise → IClusterInstance.
      // Overload signatures on IOperator narrow the type for callers.
      return result as IClusterInstance & Record<string, IClusterInstance>;
    },
  };
}
