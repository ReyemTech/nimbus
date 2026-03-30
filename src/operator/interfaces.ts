/**
 * Operator module interfaces for @reyemtech/nimbus.
 *
 * Models the real-world pattern: install an operator once, create cluster
 * instances, then provision individual databases within each cluster.
 * Each database gets connection secrets replicated to target namespaces.
 *
 * @module operator/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type * as k8s from "@pulumi/kubernetes";
import type { ICluster } from "../cluster";
import type { IBackupTarget } from "../backup";
import type { StorageTier } from "../types/storage-tiers";

/** Per-environment config overrides. Keys are environment names (e.g. "dev", "prod"). */
export type EnvironmentOverrides<T> = Record<string, Partial<T>>;

/** Supported Kubernetes database operators. */
export type OperatorType = "cloudnative-pg" | "mariadb-operator";

/** Typed constant map for OperatorType string literals. */
export const OPERATOR_TYPES = {
  CLOUDNATIVE_PG: "cloudnative-pg" as const,
  MARIADB_OPERATOR: "mariadb-operator" as const,
} satisfies Record<string, OperatorType>;

/** Default backup configuration for clusters provisioned by an operator. */
export interface IBackupDefaults {
  /** Backup target (S3 bucket + credentials). */
  readonly target: IBackupTarget;
  /** Cron schedule for scheduled backups (e.g., "0 3 * * *"). */
  readonly schedule?: string;
  /** Number of days to retain backups. */
  readonly retentionDays?: number;
  /** Enable point-in-time recovery. */
  readonly pitr?: boolean;
  /** WAL archive upload interval in seconds (CNPG-specific). Default: 300. */
  readonly pitrIntervalSeconds?: number;
}

/** Configuration for deploying a database operator via Helm. */
export interface IOperatorConfig {
  /** Cluster to deploy the operator to. */
  readonly cluster: ICluster;
  /** Kubernetes namespace for the operator. Defaults to operator-specific namespace. */
  readonly namespace?: string;
  /** Helm chart version. Uses latest if omitted. */
  readonly version?: string;
  /** Additional Helm values to merge. */
  readonly values?: Record<string, unknown>;
  /** Default backup configuration for clusters created by this operator. */
  readonly backup?: IBackupDefaults;
}

/** Per-cluster configuration when creating a database cluster via an operator. */
export interface IOperatorClusterConfig {
  /** Database engine version (e.g., "17" for PostgreSQL, "11.7" for MariaDB). */
  readonly version?: string;
  /** Number of instances/replicas. Default: 1. */
  readonly replicas?: number;
  /** Storage size in GB. Default: 10. */
  readonly storageGb?: number;
  /** Storage tier for PVC storage class selection. */
  readonly storageTier?: StorageTier;
  /** Override operator-level backup defaults for this cluster. */
  readonly backup?: Partial<IBackupDefaults>;
  /** CPU and memory resource requests/limits. */
  readonly resources?: {
    readonly requests?: { cpu?: string; memory?: string };
    readonly limits?: { cpu?: string; memory?: string };
  };
  /** Database engine parameters (e.g., max_connections, shared_buffers). */
  readonly parameters?: Record<string, string>;
  /** Resource tags (applied as labels). */
  readonly tags?: Record<string, string>;
  /** When set, creates separate clusters per environment with {name}-{env} naming. Per-env values override base config. */
  readonly environments?: EnvironmentOverrides<Omit<IOperatorClusterConfig, "environments">>;
}

/** Configuration for creating a database within a cluster. */
export interface IOperatorDatabaseConfig {
  /** Namespaces to replicate the connection secret into. */
  readonly namespaces: string[];
  /** Database owner/username. Default: same as database name. */
  readonly owner?: string;
  /** When set, creates separate databases per environment with {dbName}-{env} naming. Per-env values override base config. */
  readonly environments?: EnvironmentOverrides<Omit<IOperatorDatabaseConfig, "environments">>;
}

/** A database within a cluster, with connection secrets in target namespaces. */
export interface IDatabaseInstance {
  /** Database name. */
  readonly name: string;
  /** Cluster this database belongs to. */
  readonly clusterName: string;
  /** Database connection endpoint. */
  readonly host: pulumi.Output<string>;
  /** Database connection port. */
  readonly port: pulumi.Output<number>;
  /** Database name on the server. */
  readonly database: pulumi.Output<string>;
  /** Secrets created in target namespaces (namespace → secret name). */
  readonly secrets: Record<string, pulumi.Output<string>>;
  /** Underlying Pulumi resource for dependency wiring. */
  readonly nativeResource: pulumi.Resource;
}

/** A database cluster instance created by an operator. */
export interface IClusterInstance {
  /** Cluster name. */
  readonly name: string;
  /** Database engine type. */
  readonly engine: "postgresql" | "mariadb";
  /** Read-write endpoint for the cluster. */
  readonly endpoint: pulumi.Output<string>;
  /** Connection port. */
  readonly port: pulumi.Output<number>;
  /** Underlying CRD resource. */
  readonly nativeResource: pulumi.Resource;
  /**
   * Create a database within this cluster and replicate connection
   * secrets to specified namespaces.
   *
   * Each secret contains: host, port, username, password, database, uri.
   *
   * @param name - Database name
   * @param config - Namespaces for secret replication + optional owner
   * @returns Database instance with secret references
   */
  createDatabase(name: string, config: IOperatorDatabaseConfig): IDatabaseInstance;
  /** Overload: when environments is provided, returns a Record keyed by environment name. */
  createDatabase(name: string, config: IOperatorDatabaseConfig & Required<Pick<IOperatorDatabaseConfig, "environments">>): Record<string, IDatabaseInstance>;
}

/** Deployed database operator instance. */
export interface IOperator {
  /** Logical name of the operator. */
  readonly name: string;
  /** Operator type discriminant. */
  readonly type: OperatorType;
  /** Underlying Helm release resource. */
  readonly helmRelease: k8s.helm.v3.Release;
  /**
   * Create a database cluster via the operator.
   *
   * @param name - Cluster name (used for CRD metadata and service names)
   * @param config - Per-cluster configuration (when environments is set, returns a Record keyed by environment name)
   * @returns Cluster instance with createDatabase() for per-database provisioning
   */
  createCluster(name: string, config?: IOperatorClusterConfig): IClusterInstance;
  /** Overload: when environments is provided, returns a Record keyed by environment name. */
  createCluster(name: string, config: IOperatorClusterConfig & Required<Pick<IOperatorClusterConfig, "environments">>): Record<string, IClusterInstance>;
}
