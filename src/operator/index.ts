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
import { createMinioOperator, buildMinioHelmValues } from "./minio";
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
  IClusterInstance,
  IOperator,
  IMinIOOperator,
  IMinIOBucket,
  IMinIOBucketConfig,
} from "./interfaces";
export { OPERATOR_TYPES } from "./interfaces";

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
    repo: "https://charts.min.io",
    chart: "minio",
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
  type: "cloudnative-pg" | "mariadb-operator",
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

  // For MinIO, merge computed Helm values; for others, use caller-supplied values directly.
  const helmValues = type === "minio" ? buildMinioHelmValues(config) : (config.values ?? {});

  // Deploy Helm release
  const helmRelease = new k8s.helm.v3.Release(
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
          result = createCnpgDatabase(name, clusterConfig, config.backup, provider, helmRelease, tierMap);
          break;
        case "mariadb-operator":
          result = createMariadbDatabase(name, clusterConfig, config.backup, provider, helmRelease, tierMap);
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
