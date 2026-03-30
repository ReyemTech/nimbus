/**
 * Operator module — Kubernetes database operator deployment and database provisioning.
 *
 * Supports CloudNativePG (PostgreSQL) and MariaDB Operator via Helm.
 * Each operator exposes a createDatabase() method that provisions databases
 * via CRDs in the cluster.
 *
 * @module operator
 */

import * as k8s from "@pulumi/kubernetes";
import { assertNever } from "../types";
import { ensureNamespace } from "../utils/ensure-namespace";
import { createCnpgDatabase } from "./cnpg";
import { createMariadbDatabase } from "./mariadb";
import type { IOperator, IOperatorConfig, IOperatorClusterConfig, IClusterInstance, OperatorType } from "./interfaces";

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
} from "./interfaces";
export { OPERATOR_TYPES } from "./interfaces";

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
};

/**
 * Deploy a database operator to a Kubernetes cluster.
 *
 * Installs the operator via Helm and returns an IOperator with a createDatabase()
 * method for provisioning databases via CRDs.
 *
 * @example
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
 *
 * const db = op.createDatabase("app-db", { replicas: 2, storageGb: 20 });
 * ```
 *
 * @param type - Operator type: "cloudnative-pg" or "mariadb-operator"
 * @param config - Operator configuration
 * @returns Deployed IOperator instance
 */
export function createOperator(type: OperatorType, config: IOperatorConfig): IOperator {
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

  // Deploy Helm release
  const helmRelease = new k8s.helm.v3.Release(
    `${type}-operator`,
    {
      chart: chartInfo.chart,
      repositoryOpts: { repo: chartInfo.repo },
      version: config.version,
      namespace,
      createNamespace: false,
      values: config.values ?? {},
    },
    { provider, dependsOn: [ns, ...operatorDeps] }
  );

  return {
    name: type,
    type,
    helmRelease,
    createCluster(name: string, clusterConfig?: IOperatorClusterConfig) {
      let result: IClusterInstance | Record<string, IClusterInstance>;
      switch (type) {
        case "cloudnative-pg":
          result = createCnpgDatabase(name, clusterConfig, config.backup, provider, helmRelease);
          break;
        case "mariadb-operator":
          result = createMariadbDatabase(name, clusterConfig, config.backup, provider, helmRelease);
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
