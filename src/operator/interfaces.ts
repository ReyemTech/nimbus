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
import type { IExposedService } from "../types";

/** Per-environment config overrides. Keys are environment names (e.g. "dev", "prod"). */
export type EnvironmentOverrides<T> = Record<string, Partial<T>>;

/**
 * End-of-life policy for a declaratively managed database or role.
 *
 * - `"retain"` — the database/role survives deletion of the Kubernetes resource.
 * - `"delete"` — the operator issues `DROP DATABASE` / `DROP ROLE` on deletion.
 */
export type ReclaimPolicy = "retain" | "delete";

/**
 * A privilege grant on a database, portable across engines that model privileges.
 *
 * @example Read-only access to every current and future table in a schema
 * ```typescript
 * { privileges: ["SELECT"], schema: "marts", objects: "all" }
 * ```
 */
export interface IDatabaseGrant {
  /** Privileges to grant (e.g. ["SELECT"], ["SELECT", "INSERT"]). */
  readonly privileges: string[];
  /** Schema to scope the grant to. PostgreSQL only; ignored by engines without schemas. */
  readonly schema?: string;
  /** A specific object name, or every current and future object when "all". Default: "all". */
  readonly objects?: string;
}

/** Configuration for a role created via {@link IDatabaseInstance.addRole}. */
export interface IDatabaseRoleConfig {
  /** Namespaces to replicate the credential Secret into. */
  readonly namespaces?: string[];
  /** Whether the role can log in. Default: true. */
  readonly login?: boolean;
  /** Privileges granted to this role on the owning database. */
  readonly grants?: IDatabaseGrant[];
  /** End-of-life policy for the role. Default: "retain". */
  readonly reclaimPolicy?: ReclaimPolicy;
  /** Engine-specific options that do not port across engines. */
  readonly engineOptions?: {
    readonly postgresql?: {
      /** Existing roles this role becomes a member of (e.g. ["pg_read_all_data"]). */
      readonly inRoles?: string[];
      /** Maximum concurrent connections. Default: unlimited. */
      readonly connectionLimit?: number;
      /** Timestamp after which the password expires. */
      readonly validUntil?: string;
    };
    readonly mariadb?: {
      /** Host pattern the user may connect from. Default: "%". */
      readonly host?: string;
      /** Maximum concurrent connections. Default: 100. */
      readonly maxUserConnections?: number;
    };
  };
}

/** A role provisioned within a database. */
export interface IDatabaseRole {
  /** Role name as it exists in the database engine. */
  readonly name: string;
  /** Database this role was created for. */
  readonly databaseName: string;
  /** Cluster the database belongs to. */
  readonly clusterName: string;
  /** Secrets created in target namespaces (namespace → secret name). */
  readonly secrets: Record<string, pulumi.Output<string>>;
  /** Underlying Pulumi resource for dependency wiring. */
  readonly nativeResource: pulumi.Resource;
}

/** Supported Kubernetes database operators. */
export type OperatorType = "cloudnative-pg" | "mariadb-operator" | "minio" | "neo4j";

/** Typed constant map for OperatorType string literals. */
export const OPERATOR_TYPES = {
  CLOUDNATIVE_PG: "cloudnative-pg" as const,
  MARIADB_OPERATOR: "mariadb-operator" as const,
  NEO4J: "neo4j" as const,
  MINIO: "minio" as const,
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
  /**
   * Expose a network-reachable superuser and publish its credentials Secret
   * (CloudNativePG only). Default: false.
   *
   * Databases and roles are provisioned through the operator's own `Database`
   * and `DatabaseRole` CRDs, which run inside the instance manager and do not
   * need this. Enable it only when something outside nimbus must connect as
   * `postgres` — turning it off makes CNPG set the superuser password to NULL
   * and delete the `{cluster}-superuser` Secret.
   */
  readonly superuserAccess?: boolean;
  /** When set, creates separate clusters per environment with {name}-{env} naming. Per-env values override base config. */
  readonly environments?: EnvironmentOverrides<Omit<IOperatorClusterConfig, "environments">>;
}

/** Configuration for creating a database within a cluster. */
export interface IOperatorDatabaseConfig {
  /** Namespaces to replicate the connection secret into. */
  readonly namespaces: string[];
  /** Database owner/username. Default: same as database name. */
  readonly owner?: string;
  /**
   * What happens to the PostgreSQL database and its owning role when the
   * Kubernetes resources are deleted (CloudNativePG only). Default: `"retain"`.
   *
   * `"retain"` keeps the data, so removing a database from config — or renaming
   * the Pulumi resource — is never destructive. Set `"delete"` only for
   * databases whose lifecycle should genuinely track the config.
   */
  readonly reclaimPolicy?: ReclaimPolicy;
  /**
   * Raw SQL applied to the database as its owner, after the database and owner
   * role exist. Intended for one-off setup a CRD cannot express, such as
   * `CREATE EXTENSION IF NOT EXISTS ...` or seeding a schema.
   *
   * Statements MUST be idempotent — the Job re-runs whenever the content
   * checksum changes, and may be re-applied to a database that already has the
   * result of a previous run.
   *
   * They also run inside the surrounding transaction the applying script opens,
   * not in one of their own, so they must be transaction-safe: statements
   * PostgreSQL refuses inside a transaction block (`CREATE INDEX CONCURRENTLY`,
   * `VACUUM`) will error, and a stray `COMMIT;` closes the transaction early and
   * leaves the script's own trailing `COMMIT;` failing outside any transaction.
   *
   * @example
   * ```typescript
   * sql: ["CREATE EXTENSION IF NOT EXISTS pgcrypto;"]
   * ```
   */
  readonly sql?: string[];
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
  /**
   * Create an additional role/user on this database with a generated password,
   * replicating a connection Secret into the given namespaces.
   *
   * Optional until every backend (CloudNativePG, MariaDB, Neo4j) implements it;
   * it becomes required once all three do.
   *
   * `grants` are reconciled, not merely applied: every privilege the role holds
   * is revoked before the requested grants are re-applied, so removing a grant
   * from config actually removes it. The database owner is exempt from this and
   * cannot be passed here at all — an owner's rights over its own objects are
   * ordinary ACL entries, so revoking them would strip the owner's access to
   * the very tables it owns. The owner's role is created by `createDatabase()`.
   *
   * @param name - Role name as it will exist in the database engine
   * @param config - Namespaces, login flag, grants, and engine-specific options
   * @returns The provisioned role with its replicated Secret references
   * @throws {AnyCloudError} with code `UNSUPPORTED_ROLE_OPTION` when `grants` is
   *   passed to an engine that cannot express privileges (Neo4j Community), or
   *   when `name` is the database owner's own role name.
   */
  addRole?(name: string, config?: IDatabaseRoleConfig): IDatabaseRole;
}

/** A database cluster instance created by an operator. */
export interface IClusterInstance {
  /** Cluster name. */
  readonly name: string;
  /** Database engine type. */
  readonly engine: "postgresql" | "mariadb" | "neo4j";
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
  createDatabase(
    name: string,
    config: IOperatorDatabaseConfig & Required<Pick<IOperatorDatabaseConfig, "environments">>
  ): Record<string, IDatabaseInstance>;
}

// ---------------------------------------------------------------------------
// MinIO operator interfaces
// ---------------------------------------------------------------------------

/** Configuration for creating a MinIO bucket via the operator. */
export interface IMinIOBucketConfig {
  /** Bucket size in GB. Default: 10. */
  readonly sizeGb?: number;
  /** Enable public read access on the bucket. Default: false. */
  readonly public?: boolean;
  /** Namespaces to replicate the access credentials secret into. */
  readonly namespaces?: string[];
}

/** MinIO ingress configuration for external S3 API access. */
export interface IMinIOIngressConfig {
  /** Base domain (e.g., "reyem.ca"). */
  readonly domain: string;
  /** Subdomain prefix for the S3 API. Default: "s3". */
  readonly subdomain?: string;
  /** TLS secret name. If omitted, derived from domain. */
  readonly tlsSecretName?: string;
}

/** A MinIO bucket with endpoint, credentials, and namespace secrets. */
export interface IMinIOBucket {
  readonly name: string;
  readonly endpoint: pulumi.Output<string>;
  readonly bucketName: pulumi.Output<string>;
  readonly credentials: {
    readonly accessKeyId: pulumi.Output<string>;
    readonly secretAccessKey: pulumi.Output<string>;
  };
  /** Secrets created in target namespaces (namespace → secret name). */
  readonly secrets: Record<string, pulumi.Output<string>>;
  /** Underlying Pulumi resource for dependency wiring. */
  readonly nativeResource: pulumi.Resource;
}

/** A MinIO operator instance with createBucket(). */
export interface IMinIOOperator extends Omit<IOperator, "createCluster"> {
  /** S3 API endpoint URL (internal cluster URL). */
  readonly endpoint: pulumi.Output<string>;
  /** Services to expose via access gateway (console UI). */
  readonly exposedServices: ReadonlyArray<IExposedService>;
  /** Create a bucket on the MinIO deployment and replicate credentials to target namespaces. */
  createBucket(name: string, config?: IMinIOBucketConfig): IMinIOBucket;
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
  createCluster(
    name: string,
    config: IOperatorClusterConfig & Required<Pick<IOperatorClusterConfig, "environments">>
  ): Record<string, IClusterInstance>;
}
