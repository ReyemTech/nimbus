/**
 * Database interfaces for @reyemtech/nimbus.
 *
 * Abstracts database provisioning — managed services (RDS/Aurora,
 * Azure Database, Cloud SQL) or Kubernetes operators (PXC, CloudNativePG,
 * MariaDB Operator, MongoDB Operator).
 *
 * @module database/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type { CloudArg, ResolvedCloudTarget } from "../types";
import type { ISecretRef } from "../secrets";

/** Supported database engines. */
export type DatabaseEngine = "mysql" | "mariadb" | "postgresql" | "mongodb";

/** Database deployment mode. */
export type DatabaseMode =
  | "managed" // Cloud-native managed service (RDS, Azure Database, Cloud SQL)
  | "operator"; // In-cluster Kubernetes operator (PXC, CNPG, MariaDB Op)

/** Available database operators for in-cluster mode. */
export type DatabaseOperator =
  | "pxc" // Percona XtraDB Cluster (used by ReyemTech)
  | "mariadb-operator" // MariaDB Operator (used by DoNotCarry)
  | "cloudnative-pg" // CloudNativePG for PostgreSQL
  | "mongodb-operator"; // MongoDB Community/Enterprise Operator

/** Typed constant map for DatabaseEngine string literals. */
export const DATABASE_ENGINES = {
  MYSQL: "mysql" as const,
  MARIADB: "mariadb" as const,
  POSTGRESQL: "postgresql" as const,
  MONGODB: "mongodb" as const,
} satisfies Record<string, DatabaseEngine>;

/** Typed constant map for DatabaseMode string literals. */
export const DATABASE_MODES = {
  MANAGED: "managed" as const,
  OPERATOR: "operator" as const,
} satisfies Record<string, DatabaseMode>;

/** Typed constant map for DatabaseOperator string literals. */
export const DATABASE_OPERATORS = {
  PXC: "pxc" as const,
  MARIADB_OPERATOR: "mariadb-operator" as const,
  CLOUDNATIVE_PG: "cloudnative-pg" as const,
  MONGODB_OPERATOR: "mongodb-operator" as const,
} satisfies Record<string, DatabaseOperator>;

/** Database backup configuration. */
export interface IDatabaseBackupConfig {
  /** Whether automated backups are enabled. */
  readonly enabled: boolean;
  /** Cron schedule (e.g., "0 3 * * *" for daily at 03:00 UTC). */
  readonly schedule?: string;
  /** Number of days to retain backups before deletion. */
  readonly retentionDays?: number;
  /** Backup destination (S3 bucket, Azure Blob container, etc.). */
  readonly storageTarget?: string;
  /** Enable point-in-time recovery (PXC: binlog collector, RDS: native PITR). */
  readonly pitr?: boolean;
  /** PITR upload interval in seconds (PXC-specific). Default: 300. */
  readonly pitrIntervalSeconds?: number;
}

/**
 * Database configuration input.
 *
 * @example
 * ```typescript
 * // Managed Aurora MySQL (DoNotCarry pattern)
 * const config: IDatabaseConfig = {
 *   cloud: "aws",
 *   engine: "mysql",
 *   mode: "managed",
 *   instanceClass: "db.t3.medium",
 *   replicas: 2,
 *   highAvailability: true,
 * };
 *
 * // PXC Operator (ReyemTech pattern)
 * const config: IDatabaseConfig = {
 *   cloud: "aws",
 *   engine: "mysql",
 *   mode: "operator",
 *   operator: "pxc",
 *   replicas: 3,
 *   storageGb: 10,
 *   backup: { enabled: true, schedule: "0 3 * * *", retentionDays: 7, pitr: true },
 * };
 * ```
 */
export interface IDatabaseConfig {
  /** Cloud provider target or multi-cloud array. */
  readonly cloud: CloudArg;
  /** Database engine to provision. */
  readonly engine: DatabaseEngine;
  /** Deployment mode: managed cloud service or in-cluster operator. */
  readonly mode: DatabaseMode;
  /** Required when mode is "operator". */
  readonly operator?: DatabaseOperator;
  /** Database engine version (e.g., "8.0", "15"). Uses provider default if omitted. */
  readonly version?: string;
  /** Instance class for managed databases (e.g., "db.t3.medium"). */
  readonly instanceClass?: string;
  /** Number of replicas. Default: 1 (managed), 3 (operator). */
  readonly replicas?: number;
  /** Storage size in GB. */
  readonly storageGb?: number;
  /** Enable multi-AZ or multi-node high availability. */
  readonly highAvailability?: boolean;
  /** Backup configuration for the database. */
  readonly backup?: IDatabaseBackupConfig;
  /** Resource tags applied to the database and child resources. */
  readonly tags?: Readonly<Record<string, string>>;
}

/**
 * Database output — the created database resource.
 *
 * Provides a unified connection interface regardless of deployment mode.
 */
export interface IDatabase {
  /** Logical name of the database resource. */
  readonly name: string;
  /** Resolved cloud target this database was provisioned on. */
  readonly cloud: ResolvedCloudTarget;
  /** Database engine in use. */
  readonly engine: DatabaseEngine;
  /** Deployment mode (managed or operator). */
  readonly mode: DatabaseMode;
  /** Database connection endpoint hostname. */
  readonly endpoint: pulumi.Output<string>;
  /** Database connection port. */
  readonly port: pulumi.Output<number>;
  /** Reference to database credentials in the secrets backend. */
  readonly secretRef: ISecretRef;

  /** Escape hatch: cloud-native or operator CRD resource. */
  readonly nativeResource: pulumi.Resource;
}
