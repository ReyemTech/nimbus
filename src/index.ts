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
  CLOUD_PROVIDER,
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

export { type StorageTier, type StorageTierMap, STORAGE_TIERS, resolveStorageTier } from "./types";
export { type IExposedService } from "./types";

// Nimbus singleton
export { nimbus } from "./nimbus";
export type {
  INimbusConfig,
  INimbusResource,
  INimbusResourceRef,
  INotificationsConfig,
  INotificationEmailConfig,
  INotificationSlackConfig,
  NimbusResourceType,
} from "./nimbus";

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
export { NAT_STRATEGIES } from "./network";

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
export { DNS_RECORD_TYPES } from "./dns";

// Secrets
export type { SecretBackend, ISecretRef, ISecretsConfig, ISecrets } from "./secrets";
export { SECRET_BACKENDS } from "./secrets";

// Database
export type {
  DatabaseEngine,
  DatabaseMode,
  DatabaseOperator,
  IDatabaseBackupConfig,
  IDatabaseConfig,
  IDatabase,
} from "./database";
export { DATABASE_ENGINES, DATABASE_MODES, DATABASE_OPERATORS } from "./database";

// Cache
export {
  type CacheEngine,
  type CacheMode,
  type CacheArchitecture,
  type ICacheConfig,
  type ICache,
  createCache,
  CACHE_ENGINES,
  CACHE_MODES,
  CACHE_ARCHITECTURES,
} from "./cache";

// Object Storage
export type { ILifecycleRule, ICorsRule, IObjectStorageConfig, IObjectStorage } from "./storage";

// Backup
export type { IBackupReplicationConfig, IBackupTargetConfig, IBackupTarget } from "./backup";
export { createBackupTarget } from "./backup";

// Operator
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
  IMinIOIngressConfig,
} from "./operator";
export { createOperator, createMinioIngress, OPERATOR_TYPES } from "./operator";
export type { INeo4jClusterConfig } from "./operator";

// Queue
export type { QueueEngine, QueueMode, QueueType, IQueueConfig, IQueue } from "./queue";
export { QUEUE_ENGINES, QUEUE_MODES, QUEUE_TYPES } from "./queue";

// State Backend
export type {
  StateBackendType,
  IReplicationConfig,
  IStateLockConfig,
  IStateBackendConfig,
  IStateBackend,
} from "./state";
export { STATE_BACKEND_TYPES } from "./state";

// Platform
export {
  type DnsProvider,
  type IPlatformComponentConfig,
  type IExternalDnsConfig,
  type IVaultConfig,
  type IAutoUnsealConfig,
  type IAwsKmsUnsealConfig,
  type IAzureKeyVaultUnsealConfig,
  type IGcpCkmsUnsealConfig,
  type IPlatformStackConfig,
  type IPlatformStack,
  createPlatformStack,
  DNS_PROVIDERS,
} from "./platform";

// Access Gateway
export {
  type AccessGatewayProvider,
  type IAccessDnsConfig,
  type ITailscaleConfig,
  type IWireGuardPeer,
  type IWireGuardConfig,
  type ITailscaleGatewayConfig,
  type IWireGuardGatewayConfig,
  type IAccessGatewayConfig,
  type IAccessGateway,
  createAccessGateway,
  ACCESS_GATEWAY_PROVIDERS,
} from "./access";

// ArgoCD
export {
  type ArgoRepoType,
  type IArgoRepoConfig,
  type IArgoRepoRef,
  type IArgoAppSource,
  type IArgoSyncPolicy,
  type IArgoProjectConfig,
  type IArgoAppConfig,
  type IArgoSecretsConfig,
  type IArgoAppSecrets,
  type IArgoCDConfig,
  ArgoCD,
  ArgoProject,
  ArgoApp,
  createArgoCD,
  createAppSecrets,
  createExternalSecrets,
  type IExternalSecretsConfig,
} from "./argocd";

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
  type IAlertConfig,
  type IAlertEmailConfig,
  type IAlertSlackConfig,
  type IObservabilityStackConfig,
  type IObservabilityStack,
  type IPrometheusRuleGroup,
  type IPrometheusAlertRule,
  createObservabilityStack,
  createPrometheusRule,
  parseDurationToSeconds,
} from "./observability";

// Azure resource group helper
export { ensureResourceGroup, type IResourceGroupOptions } from "./azure/resource-group";

// Email Transport
export {
  type EmailProvider,
  type IEmailTransportConfig,
  type ISesTransportConfig,
  type ISmtpTransportConfig,
  type IResendTransportConfig,
  type IMailgunTransportConfig,
  type IEmailTransport,
  createEmailTransport,
  EMAIL_PROVIDERS,
} from "./email";

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
