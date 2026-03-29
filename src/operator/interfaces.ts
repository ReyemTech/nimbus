/**
 * Operator module interfaces for @reyemtech/nimbus.
 *
 * Abstracts Kubernetes database operator deployment and database provisioning
 * via CRDs for CloudNativePG (PostgreSQL) and MariaDB Operator.
 *
 * @module operator/interfaces
 */

import type * as k8s from "@pulumi/kubernetes";
import type { ICluster } from "../cluster";
import type { IBackupTarget } from "../backup";
import type { IDatabase } from "../database";
import type { StorageTier } from "../types/storage-tiers";

/** Supported Kubernetes database operators. */
export type OperatorType = "cloudnative-pg" | "mariadb-operator";

/** Default backup configuration for databases provisioned by an operator. */
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
  /** Default backup configuration for databases created by this operator. */
  readonly backup?: IBackupDefaults;
}

/** Per-database configuration when creating a database via an operator. */
export interface IOperatorDatabaseConfig {
  /** Database engine version (e.g., "16" for PostgreSQL, "11" for MariaDB). */
  readonly version?: string;
  /** Number of replicas. Default: 1. */
  readonly replicas?: number;
  /** Storage size in GB. Default: 10. */
  readonly storageGb?: number;
  /** Storage tier for PVC storage class selection. */
  readonly storageTier?: StorageTier;
  /** Override operator-level backup defaults for this database. */
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
   * Provision a database via the operator.
   *
   * @param name - Database name (used for CRD metadata and service names)
   * @param config - Per-database configuration
   * @returns Unified IDatabase output
   */
  createDatabase(name: string, config?: IOperatorDatabaseConfig): IDatabase;
}
