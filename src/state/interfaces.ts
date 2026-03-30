/**
 * State backend interfaces for @reyemtech/nimbus.
 *
 * Abstracts Pulumi state storage (S3, Azure Blob) with BCDR features:
 * versioning, encryption, replication, and locking.
 *
 * @module state/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type { CloudArg, ResolvedCloudTarget } from "../types";

/** Supported state backend storage types. */
export type StateBackendType = "s3" | "azblob" | "gs";

/** Typed constant map for StateBackendType string literals. */
export const STATE_BACKEND_TYPES = {
  S3: "s3" as const,
  AZBLOB: "azblob" as const,
  GS: "gs" as const,
} satisfies Record<string, StateBackendType>;

/** Cross-region replication configuration. */
export interface IReplicationConfig {
  /** Enable cross-region replication for disaster recovery. */
  readonly enabled: boolean;
  /** Destination region for replication. */
  readonly destinationRegion?: string;
}

/** State locking configuration. */
export interface IStateLockConfig {
  /** Enable state locking. Default: true. */
  readonly enabled?: boolean;
  /** DynamoDB table name for AWS state locking. Auto-generated if not provided. */
  readonly dynamoDbTableName?: string;
}

/**
 * State backend configuration input.
 *
 * @example
 * ```typescript
 * const config: IStateBackendConfig = {
 *   cloud: "aws",
 *   versioning: true,
 *   encryption: true,
 *   locking: { enabled: true },
 *   replication: { enabled: true, destinationRegion: "us-west-2" },
 * };
 * ```
 */
export interface IStateBackendConfig {
  readonly cloud: CloudArg;
  /** Override the auto-detected backend type. */
  readonly backendType?: StateBackendType;
  /** Enable bucket/container versioning. Default: true. */
  readonly versioning?: boolean;
  /** Enable server-side encryption. Default: true. */
  readonly encryption?: boolean;
  /** State locking configuration. Default: enabled. */
  readonly locking?: IStateLockConfig;
  /** Cross-region replication configuration. */
  readonly replication?: IReplicationConfig;
  /** Resource tags. */
  readonly tags?: Readonly<Record<string, string>>;
}

/**
 * State backend output — the created state storage resources.
 *
 * Use `backendUrl` to configure Pulumi's backend:
 * ```
 * pulumi login s3://bucket-name
 * pulumi login azblob://container-name
 * ```
 */
export interface IStateBackend {
  readonly name: string;
  readonly cloud: ResolvedCloudTarget;
  readonly backendType: StateBackendType;
  /** Backend URL for `pulumi login`. e.g., `s3://bucket-name` or `azblob://container-name`. */
  readonly backendUrl: pulumi.Output<string>;
  readonly bucketName: pulumi.Output<string>;
  /** DynamoDB table name for state locking (AWS only). */
  readonly lockTableName?: pulumi.Output<string>;
  /** Storage account name (Azure only). */
  readonly storageAccountName?: pulumi.Output<string>;
  readonly versioning: boolean;
  readonly encryption: boolean;
  readonly replicationEnabled: boolean;
  /** Escape hatch: cloud-native state storage resource. */
  readonly nativeResource: pulumi.Resource;
}
