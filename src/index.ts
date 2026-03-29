/**
 * @reyemtech/nimbus
 *
 * Cloud-agnostic infrastructure abstractions for Pulumi.
 * Enables BCDR: any client environment fully reproducible from code,
 * cloud migration = change one config value.
 *
 * @packageDocumentation
 */

// Core types
export {
  type CloudProvider,
  type CloudTarget,
  type CloudArg,
  type ResolvedCloudTarget,
  DEFAULT_REGIONS,
  CLOUD_PROVIDERS,
  isCloudProvider,
  isCloudTarget,
  resolveCloudTarget,
} from "./types";

export {
  type ErrorCode,
  ERROR_CODES,
  AnyCloudError,
  CloudValidationError,
  CidrError,
  UnsupportedFeatureError,
  ConfigError,
  assertNever,
} from "./types";

export { type IRequiredTags, normalizeTags, isValidGcpLabel, mergeWithRequiredTags } from "./types";

export {
  type IValidationResult,
  validateFeature,
  isFeatureSupported,
  validateMultiCloud,
  validateResourceName,
  assertValidMultiCloud,
} from "./types";

export { type StorageTier, type StorageTierMap, resolveStorageTier } from "./types";

// Cluster
export type {
  INodeTaint,
  INodePool,
  IClusterConfig,
  ICluster,
  IEksClusterExtensions,
  IAksClusterExtensions,
  IGkeClusterExtensions,
  ProviderClusterExtensions,
} from "./cluster";

// Network
export type { NatStrategy, ISubnetConfig, INetworkConfig, INetwork } from "./network";

export {
  parseCidr,
  formatIp,
  cidrsOverlap,
  detectOverlaps,
  validateNoOverlaps,
  autoOffsetCidrs,
  buildCidrMap,
} from "./network";

// DNS
export type { DnsRecordType, IDnsRecord, IDnsConfig, IDns } from "./dns";

// Secrets
export type { SecretBackend, ISecretRef, ISecretsConfig, ISecrets } from "./secrets";

// Database
export type {
  DatabaseEngine,
  DatabaseMode,
  DatabaseOperator,
  IDatabaseBackupConfig,
  IDatabaseConfig,
  IDatabase,
} from "./database";

// Cache
export type { CacheEngine, CacheMode, CacheArchitecture, ICacheConfig, ICache } from "./cache";

// Object Storage
export type { ILifecycleRule, ICorsRule, IObjectStorageConfig, IObjectStorage } from "./storage";

// Backup
export type { IBackupReplicationConfig, IBackupTargetConfig, IBackupTarget } from "./backup";
export { createBackupTarget } from "./backup";

// Operator
export type {
  OperatorType,
  IBackupDefaults,
  IOperatorConfig,
  IOperatorDatabaseConfig,
  IOperator,
} from "./operator";
export { createOperator } from "./operator";

// Queue
export type { QueueEngine, QueueMode, QueueType, IQueueConfig, IQueue } from "./queue";

// State Backend
export type {
  StateBackendType,
  IReplicationConfig,
  IStateLockConfig,
  IStateBackendConfig,
  IStateBackend,
} from "./state";

// Platform
export {
  type DnsProvider,
  type IPlatformComponentConfig,
  type IExternalDnsConfig,
  type IVaultConfig,
  type IPlatformStackConfig,
  type IPlatformStack,
  createPlatformStack,
} from "./platform";

// Global Load Balancer
export {
  type RoutingStrategy,
  type GlbDnsProvider,
  type IHealthCheck,
  type IGlobalLoadBalancerConfig,
  type IClusterHealthStatus,
  type IGlobalLoadBalancer,
  createGlobalLoadBalancer,
} from "./global-lb";

// Observability
export {
  type IPrometheusConfig,
  type IGrafanaConfig,
  type ILokiConfig,
  type IAlloyConfig,
  type IAlertmanagerConfig,
  type IObservabilityStackConfig,
  type IObservabilityStack,
  createObservabilityStack,
} from "./observability";

// Azure resource group helper
export { ensureResourceGroup, type IResourceGroupOptions } from "./azure/resource-group";

// Utilities
export { ensureNamespace } from "./utils/ensure-namespace";

// Factory functions (primary API)
export {
  createNetwork,
  createCluster,
  createDns,
  createSecrets,
  createStateBackend,
  type ICreateNetworkConfig,
  type ICreateClusterConfig,
  type ICreateDnsConfig,
  type ICreateSecretsConfig,
  type ICreateStateBackendConfig,
  type IProviderOptions,
  type IAwsProviderOptions,
  type IAzureProviderOptions,
  extractProvider,
  isMultiCloud,
} from "./factories";
