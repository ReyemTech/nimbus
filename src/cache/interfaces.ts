/**
 * Cache interfaces for @reyemtech/nimbus.
 *
 * Abstracts Redis/Memcached/Valkey provisioning — managed services
 * (ElastiCache, Azure Cache, Memorystore) or Helm-based (Bitnami Redis).
 *
 * @module cache/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type { CloudArg, ResolvedCloudTarget } from "../types";
import type { StorageTier } from "../types/storage-tiers";
import type { ISecretRef } from "../secrets";

/** Supported cache engines. */
export type CacheEngine = "redis" | "memcached" | "valkey";

/** Cache deployment mode. */
export type CacheMode =
  | "managed" // Cloud-native (ElastiCache, Azure Cache, Memorystore)
  | "helm"; // In-cluster via Helm chart (Bitnami Redis)

/** Cache architecture. */
export type CacheArchitecture =
  | "standalone" // Single node
  | "replication" // Master + replicas
  | "cluster"; // Redis Cluster mode (sharded)

/** Typed constant map for CacheEngine string literals. */
export const CACHE_ENGINES = {
  REDIS: "redis" as const,
  MEMCACHED: "memcached" as const,
  VALKEY: "valkey" as const,
} satisfies Record<string, CacheEngine>;

/** Typed constant map for CacheMode string literals. */
export const CACHE_MODES = {
  MANAGED: "managed" as const,
  HELM: "helm" as const,
} satisfies Record<string, CacheMode>;

/** Typed constant map for CacheArchitecture string literals. */
export const CACHE_ARCHITECTURES = {
  STANDALONE: "standalone" as const,
  REPLICATION: "replication" as const,
  CLUSTER: "cluster" as const,
} satisfies Record<string, CacheArchitecture>;

/**
 * Cache configuration input.
 *
 * @example
 * ```typescript
 * // Bitnami Redis (ReyemTech pattern)
 * const config: ICacheConfig = {
 *   cloud: "aws",
 *   engine: "redis",
 *   mode: "helm",
 *   architecture: "replication",
 *   replicas: 2,
 *   storageGb: 5,
 *   metrics: true,
 * };
 * ```
 */
export interface ICacheConfig {
  /** Cloud provider target or multi-cloud array. */
  readonly cloud: CloudArg;
  /** Cache engine to provision. */
  readonly engine: CacheEngine;
  /** Deployment mode: managed cloud service or Helm chart. */
  readonly mode?: CacheMode;
  /** Cache topology: standalone, replication, or cluster. */
  readonly architecture?: CacheArchitecture;
  /** Number of read replicas. */
  readonly replicas?: number;
  /** Instance class for managed caches. */
  readonly instanceClass?: string;
  /** Persistent storage size in GB (for Helm-based). */
  readonly storageGb?: number;
  /** Storage performance tier mapped to cluster storage class. */
  readonly storageTier?: StorageTier;
  /** Memory limit for cache instances (e.g., "512Mi", "1Gi"). Default: "256Mi". */
  readonly memory?: string;
  /** Enable Prometheus metrics exporter. */
  readonly metrics?: boolean;
  /** Resource tags applied to the cache and child resources. */
  readonly tags?: Readonly<Record<string, string>>;
  /** Namespaces to replicate connection secrets into (host, port, password, uri). */
  readonly namespaces?: string[];
}

/** Cache output — the created cache resource. */
export interface ICache {
  /** Logical name of the cache resource. */
  readonly name: string;
  /** Resolved cloud target this cache was provisioned on. */
  readonly cloud: ResolvedCloudTarget;
  /** Cache engine in use. */
  readonly engine: CacheEngine;
  /** Cache connection endpoint hostname. */
  readonly endpoint: pulumi.Output<string>;
  /** Cache connection port. */
  readonly port: pulumi.Output<number>;
  /** Reference to cache credentials in the secrets backend, if authentication is enabled. */
  readonly secretRef?: ISecretRef;

  /** Connection secrets replicated to target namespaces (namespace → secret name). */
  readonly secrets: Record<string, pulumi.Output<string>>;

  /** Escape hatch: cloud-native or Helm release resource. */
  readonly nativeResource: pulumi.Resource;
}
