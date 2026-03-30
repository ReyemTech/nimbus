# @reyemtech/nimbus — Interface Definitions

**Date:** 2026-02-13
**Status:** Design (REY-84)
**Informed by:** Environment audits (REY-83)

---

## Cloud Target Types

```typescript
/** Supported cloud providers */
type CloudProvider = "aws" | "azure" | "gcp";

/** Explicit cloud target with provider and region */
interface CloudTarget {
  readonly provider: CloudProvider;
  readonly region?: string; // Falls back to DEFAULT_REGIONS if omitted
}

/** Flexible cloud argument — string shorthand, explicit target, or multi-cloud array */
type CloudArg = CloudProvider | CloudTarget | ReadonlyArray<CloudProvider | CloudTarget>;

/** Default regions when none specified */
const DEFAULT_REGIONS: Readonly<Record<CloudProvider, string>> = {
  aws: "us-east-1",
  azure: "eastus",
  gcp: "us-central1",
} as const;

/** Resolved cloud target (always has both provider and region) */
interface ResolvedCloudTarget {
  readonly provider: CloudProvider;
  readonly region: string;
}
```

### Config File Support

```yaml
# Pulumi.<stack>.yaml
config:
  any-cloud:clouds:
    - provider: aws
      region: us-east-1
    - provider: azure
      region: canadacentral
```

When `cloud` is a string (e.g., `"aws"`), the factory looks up the region from the Pulumi config file. If not found, falls back to `DEFAULT_REGIONS`.

---

## Core Interfaces

### ICluster

Abstracts Kubernetes cluster provisioning across EKS, AKS, Rackspace Spot, and GKE.

```typescript
/** Node pool configuration */
interface INodePool {
  readonly name: string;
  readonly instanceType: string;
  readonly minNodes: number;
  readonly maxNodes: number;
  readonly desiredNodes?: number;
  readonly spot?: boolean;
  readonly labels?: Readonly<Record<string, string>>;
  readonly taints?: ReadonlyArray<INodeTaint>;
  readonly mode?: "system" | "user"; // AKS concept, maps to labels on others
}

interface INodeTaint {
  readonly key: string;
  readonly value: string;
  readonly effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
}

/** Cluster configuration input */
interface IClusterConfig {
  readonly cloud: CloudArg;
  readonly version?: string; // K8s version
  readonly nodePools: ReadonlyArray<INodePool>;
  readonly autoMode?: boolean; // EKS Auto Mode (no explicit node groups)
  readonly virtualNodes?: boolean; // ACI on AKS
  readonly tags?: Readonly<Record<string, string>>;
}

/** Cluster output — what you get back */
interface ICluster {
  readonly name: string;
  readonly cloud: ResolvedCloudTarget;
  readonly endpoint: pulumi.Output<string>;
  readonly kubeconfig: pulumi.Output<string>;
  readonly version: pulumi.Output<string>;
  readonly nodePools: ReadonlyArray<INodePool>;

  /** Escape hatch — access the cloud-native resource */
  readonly nativeResource:
    | aws.eks.Cluster
    | azure.containerservice.ManagedCluster
    | gcp.container.Cluster;

  /** Pulumi provider for deploying to this cluster */
  readonly provider: k8s.Provider;
}
```

**Audit-informed decisions:**

- `autoMode` for EKS Auto Mode (DoNotCarry pattern)
- `virtualNodes` for AKS ACI connector (MetrixGroup pattern)
- `spot` per-pool (ReyemTech = all spot, DoNotCarry = Auto Mode mixed)
- `mode: "system" | "user"` from AKS node pools (MetrixGroup has smallsys/smalluser)

### INetwork

Abstracts VPC (AWS), VNet (Azure), or skips networking for hosted K8s (Rackspace).

```typescript
/** NAT strategy */
type NatStrategy = "managed" | "fck-nat" | "none";

/** Subnet configuration */
interface ISubnetConfig {
  readonly cidr: string;
  readonly availabilityZone?: string;
  readonly public?: boolean;
}

/** Network configuration input */
interface INetworkConfig {
  readonly cloud: CloudArg;
  readonly cidr: string; // e.g., "10.0.0.0/16"
  readonly publicSubnets?: ReadonlyArray<ISubnetConfig>;
  readonly privateSubnets?: ReadonlyArray<ISubnetConfig>;
  readonly natStrategy?: NatStrategy; // Default: "managed"
  readonly enableDnsHostnames?: boolean;
  readonly enableDnsSupport?: boolean;
  readonly tags?: Readonly<Record<string, string>>;
}

/** Network output */
interface INetwork {
  readonly name: string;
  readonly cloud: ResolvedCloudTarget;
  readonly vpcId: pulumi.Output<string>; // VPC ID (AWS) or VNet ID (Azure)
  readonly cidr: string;
  readonly publicSubnetIds: pulumi.Output<ReadonlyArray<string>>;
  readonly privateSubnetIds: pulumi.Output<ReadonlyArray<string>>;
  readonly natGatewayId?: pulumi.Output<string>;

  /** Escape hatch */
  readonly nativeResource: aws.ec2.Vpc | azure.network.VirtualNetwork | gcp.compute.Network;
}
```

**Audit-informed decisions:**

- `NatStrategy` with `"fck-nat"` option — DoNotCarry pays $101/mo for NAT Gateway
- Network may be optional (ReyemTech on Rackspace has no custom networking)
- CIDR auto-offset for multi-cloud (avoid overlaps for peering/mesh)

### IDns

Abstracts DNS zone management across Route 53, Azure DNS, and Cloud DNS.

```typescript
/** DNS record type */
type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT" | "MX" | "NS" | "SRV" | "CAA";

/** DNS record configuration */
interface IDnsRecord {
  readonly name: string; // e.g., "www" or "argocd"
  readonly type: DnsRecordType;
  readonly values: ReadonlyArray<string>;
  readonly ttl?: number; // Default: 300
}

/** DNS configuration input */
interface IDnsConfig {
  readonly cloud: CloudArg;
  readonly zoneName: string; // e.g., "reyem.tech"
  readonly records?: ReadonlyArray<IDnsRecord>;
  readonly tags?: Readonly<Record<string, string>>;
}

/** DNS output */
interface IDns {
  readonly name: string;
  readonly cloud: ResolvedCloudTarget;
  readonly zoneId: pulumi.Output<string>;
  readonly zoneName: string;
  readonly nameServers: pulumi.Output<ReadonlyArray<string>>;

  /** Add a record to the zone */
  addRecord(record: IDnsRecord): void;

  /** Escape hatch */
  readonly nativeResource: aws.route53.Zone | azure.dns.Zone | gcp.dns.ManagedZone;
}
```

**Audit-informed decisions:**

- ReyemTech: Route 53 (reyem.tech), auth via IAM credentials
- DoNotCarry: Route 53 (donotcarry.com, donotcarry.tech), auth via Pod Identity
- MetrixGroup: Azure DNS Zone (metrixgroup.com), auth via Managed Identity

### ISecrets

Abstracts secret management across Vault, AWS Secrets Manager, and Azure Key Vault.

```typescript
/** Supported secret backends */
type SecretBackend = "vault" | "aws-secrets-manager" | "azure-key-vault" | "gcp-secret-manager";

/** Secret reference */
interface ISecretRef {
  readonly path: string; // e.g., "operators/mysql"
  readonly key?: string; // Specific key within the secret
}

/** Secrets configuration input */
interface ISecretsConfig {
  readonly cloud: CloudArg;
  readonly backend?: SecretBackend; // Default: "vault" for in-cluster, cloud-native otherwise
  readonly vaultAddress?: string; // If using Vault
  readonly tags?: Readonly<Record<string, string>>;
}

/** Secrets output */
interface ISecrets {
  readonly name: string;
  readonly cloud: ResolvedCloudTarget;
  readonly backend: SecretBackend;

  /** Store a secret */
  putSecret(path: string, data: Record<string, pulumi.Input<string>>): void;

  /** Reference a secret (for use in other resources) */
  getSecretRef(ref: ISecretRef): pulumi.Output<string>;

  /** Escape hatch */
  readonly nativeResource:
    | aws.secretsmanager.Secret
    | azure.keyvault.Vault
    | gcp.secretmanager.Secret
    | k8s.helm.v3.Release; // Vault Helm release
}
```

**Audit-informed decisions:**

- ReyemTech + DoNotCarry: Vault (in-cluster) + External Secrets Operator
- MetrixGroup: Azure Key Vault + Secrets Store CSI Driver
- Support both patterns: Vault + ESO (default) or cloud-native + CSI

### IStateBackend

Abstracts Pulumi state storage (S3, Azure Blob) with BCDR features: versioning, encryption, replication, and locking.

```typescript
/** Supported state backend storage types */
type StateBackendType = "s3" | "azblob" | "gs";

/** Cross-region replication configuration */
interface IReplicationConfig {
  readonly enabled: boolean;
  readonly destinationRegion?: string;
}

/** State locking configuration */
interface IStateLockConfig {
  readonly enabled?: boolean; // Default: true
  readonly dynamoDbTableName?: string; // AWS only, auto-generated if not provided
}

/** State backend configuration input */
interface IStateBackendConfig {
  readonly cloud: CloudArg;
  readonly backendType?: StateBackendType;
  readonly versioning?: boolean; // Default: true
  readonly encryption?: boolean; // Default: true
  readonly locking?: IStateLockConfig;
  readonly replication?: IReplicationConfig;
  readonly tags?: Readonly<Record<string, string>>;
}

/** State backend output */
interface IStateBackend {
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

  /** Escape hatch */
  readonly nativeResource: pulumi.Resource;
}
```

**Implementation notes:**

- **AWS:** S3 BucketV2 + PublicAccessBlock + BucketVersioningV2 + SSE (AES256 or KMS via `stateKmsKeyArn`) + DynamoDB table (PAY_PER_REQUEST, `LockID` hash key) + optional cross-region replication (replica bucket + IAM role/policy + BucketReplicationConfig)
- **Azure:** StorageAccount (StorageV2, HTTPS-only, TLS 1.2, no public blob) + BlobContainer ("pulumistate") + BlobServiceProperties with versioning. SKU: `Standard_GRS` if replication enabled, `Standard_LRS` otherwise. Locking uses Azure blob leases natively (no separate table needed).

### IDatabase

Abstracts database provisioning — managed (RDS, Azure Database) or operator-based (PXC, CloudNativePG).

```typescript
/** Database engine */
type DatabaseEngine = "mysql" | "mariadb" | "postgresql" | "mongodb";

/** Database deployment mode */
type DatabaseMode = "managed" | "operator";

/** Database operator type */
type DatabaseOperator = "pxc" | "mariadb-operator" | "cloudnative-pg" | "mongodb-operator";

/** Database configuration input */
interface IDatabaseConfig {
  readonly cloud: CloudArg;
  readonly engine: DatabaseEngine;
  readonly mode: DatabaseMode;
  readonly operator?: DatabaseOperator; // Required if mode = "operator"
  readonly version?: string;
  readonly instanceClass?: string; // For managed (e.g., "db.t3.medium")
  readonly replicas?: number; // Default: 1 for managed, 3 for operator
  readonly storageGb?: number;
  readonly highAvailability?: boolean;
  readonly backup?: IDatabaseBackupConfig;
  readonly tags?: Readonly<Record<string, string>>;
}

interface IDatabaseBackupConfig {
  readonly enabled: boolean;
  readonly schedule?: string; // Cron expression
  readonly retentionDays?: number;
  readonly storageTarget?: string; // S3 bucket, Azure Blob container, etc.
  readonly pitr?: boolean; // Point-in-time recovery
}

/** Database output */
interface IDatabase {
  readonly name: string;
  readonly cloud: ResolvedCloudTarget;
  readonly engine: DatabaseEngine;
  readonly mode: DatabaseMode;
  readonly endpoint: pulumi.Output<string>;
  readonly port: pulumi.Output<number>;
  readonly secretRef: ISecretRef; // Reference to credentials

  /** Escape hatch */
  readonly nativeResource:
    | aws.rds.Cluster // Aurora
    | aws.rds.Instance
    | azure.dbformysql.FlexibleServer
    | azure.dbforpostgresql.FlexibleServer
    | k8s.apiextensions.CustomResource; // Operator CRD
}
```

**Audit-informed decisions:**

- ReyemTech: PXC Operator (3-node Galera, MySQL 8.4, PITR to S3)
- DoNotCarry: Aurora MySQL (db.t3.medium, 2 instances) + MariaDB Galera Operator
- MetrixGroup: Per-app PostgreSQL Helm charts + MongoDB Helm
- Must support both managed and operator modes

### ICache

Abstracts Redis/Memcached provisioning.

```typescript
/** Cache engine */
type CacheEngine = "redis" | "memcached" | "valkey";

/** Cache mode */
type CacheMode = "managed" | "helm";

/** Cache architecture */
type CacheArchitecture = "standalone" | "replication" | "cluster";

/** Cache configuration input */
interface ICacheConfig {
  readonly cloud: CloudArg;
  readonly engine: CacheEngine;
  readonly mode?: CacheMode; // Default: "helm"
  readonly architecture?: CacheArchitecture; // Default: "replication"
  readonly replicas?: number;
  readonly instanceClass?: string; // For managed
  readonly storageGb?: number; // For persistence
  readonly metrics?: boolean;
  readonly tags?: Readonly<Record<string, string>>;
}

/** Cache output */
interface ICache {
  readonly name: string;
  readonly cloud: ResolvedCloudTarget;
  readonly engine: CacheEngine;
  readonly endpoint: pulumi.Output<string>;
  readonly port: pulumi.Output<number>;
  readonly secretRef?: ISecretRef;

  /** Escape hatch */
  readonly nativeResource:
    | aws.elasticache.ReplicationGroup
    | azure.cache.RedisCache
    | gcp.redis.Instance
    | k8s.helm.v3.Release;
}
```

**Audit-informed decisions:**

- ReyemTech: Bitnami Redis (standalone + 2 replicas, 5 Gi persistence)
- DoNotCarry: Redis (1 master + 3 replicas)
- MetrixGroup: Redis (ArgoCD only, 8 Gi)

### IObjectStorage

Abstracts S3/Azure Blob/GCS bucket management.

```typescript
/** Object storage configuration input */
interface IObjectStorageConfig {
  readonly cloud: CloudArg;
  readonly versioning?: boolean;
  readonly encryption?: boolean; // Default: true
  readonly lifecycleRules?: ReadonlyArray<ILifecycleRule>;
  readonly publicAccess?: boolean; // Default: false
  readonly corsRules?: ReadonlyArray<ICorsRule>;
  readonly tags?: Readonly<Record<string, string>>;
}

interface ILifecycleRule {
  readonly prefix?: string;
  readonly expirationDays?: number;
  readonly transitionDays?: number;
  readonly transitionStorageClass?: string;
}

interface ICorsRule {
  readonly allowedOrigins: ReadonlyArray<string>;
  readonly allowedMethods: ReadonlyArray<string>;
  readonly allowedHeaders?: ReadonlyArray<string>;
  readonly maxAgeSeconds?: number;
}

/** Object storage output */
interface IObjectStorage {
  readonly name: string;
  readonly cloud: ResolvedCloudTarget;
  readonly bucketName: pulumi.Output<string>;
  readonly bucketArn?: pulumi.Output<string>; // AWS
  readonly endpoint: pulumi.Output<string>;

  /** Escape hatch */
  readonly nativeResource: aws.s3.BucketV2 | azure.storage.BlobContainer | gcp.storage.Bucket;
}
```

### IQueue

Abstracts message queue provisioning.

```typescript
/** Queue engine */
type QueueEngine = "sqs" | "service-bus" | "pub-sub" | "nats" | "rabbitmq" | "kafka";

/** Queue mode */
type QueueMode = "managed" | "operator";

/** Queue type */
type QueueType = "standard" | "fifo" | "streaming";

/** Queue configuration input */
interface IQueueConfig {
  readonly cloud: CloudArg;
  readonly engine?: QueueEngine; // Auto-selected based on cloud if omitted
  readonly mode?: QueueMode;
  readonly queueType?: QueueType; // Default: "standard"
  readonly tags?: Readonly<Record<string, string>>;
}

/** Queue output */
interface IQueue {
  readonly name: string;
  readonly cloud: ResolvedCloudTarget;
  readonly engine: QueueEngine;
  readonly endpoint: pulumi.Output<string>;

  /** Escape hatch */
  readonly nativeResource:
    | aws.sqs.Queue
    | azure.servicebus.Queue
    | gcp.pubsub.Topic
    | k8s.helm.v3.Release;
}
```

---

## Platform Layer

### IPlatformStack

Cloud-agnostic platform components deployed via Helm to any `ICluster`.

```typescript
/** Individual platform component configuration */
interface IPlatformComponentConfig {
  readonly enabled?: boolean; // Default: true
  readonly version?: string; // Chart version override
  readonly values?: Record<string, unknown>; // Helm values override
}

/** Platform stack configuration */
interface IPlatformStackConfig {
  readonly cluster: ICluster | ReadonlyArray<ICluster>;
  readonly domain: string;

  /** Core components (enabled by default) */
  readonly traefik?: IPlatformComponentConfig;
  readonly certManager?: IPlatformComponentConfig;
  readonly externalDns?: IPlatformComponentConfig & {
    readonly dnsProvider: "route53" | "azure-dns" | "cloud-dns" | "cloudflare";
    readonly dnsCredentials?: Record<string, pulumi.Input<string>>;
  };

  /** Optional components */
  readonly argocd?: IPlatformComponentConfig;
  readonly vault?: IPlatformComponentConfig;
  readonly externalSecrets?: IPlatformComponentConfig;

  readonly tags?: Readonly<Record<string, string>>;
}

/** Platform stack output */
interface IPlatformStack {
  readonly name: string;
  readonly cluster: ICluster;
  readonly components: Readonly<Record<string, k8s.helm.v3.Release>>;
  readonly traefikEndpoint: pulumi.Output<string>;
}
```

**Audit-informed decisions:**

- Traefik is universal across all 3 environments — default enabled
- ArgoCD is universal — default enabled
- cert-manager + External DNS universal — default enabled
- Vault + ESO: 2/3 environments — default enabled but configurable
- OAuth2 Proxy: 1/3 — optional component

### IGlobalLoadBalancer

Multi-cloud traffic routing.

```typescript
/** Routing strategy */
type RoutingStrategy = "active-active" | "active-passive" | "geo";

/** Health check configuration */
interface IHealthCheck {
  readonly path: string;
  readonly port: number;
  readonly protocol: "HTTP" | "HTTPS" | "TCP";
  readonly intervalSeconds?: number;
  readonly timeoutSeconds?: number;
  readonly healthyThreshold?: number;
  readonly unhealthyThreshold?: number;
}

/** Global load balancer configuration */
interface IGlobalLoadBalancerConfig {
  readonly strategy: RoutingStrategy;
  readonly clusters: ReadonlyArray<ICluster>;
  readonly domain: string;
  readonly healthCheck: IHealthCheck;
  readonly dnsProvider: "route53" | "cloudflare" | "azure-traffic-manager";
}

/** Global load balancer output */
interface IGlobalLoadBalancer {
  readonly name: string;
  readonly strategy: RoutingStrategy;
  readonly endpoint: pulumi.Output<string>;
  readonly healthStatus: pulumi.Output<
    ReadonlyArray<{
      readonly cluster: string;
      readonly healthy: boolean;
    }>
  >;
}
```

---

## Factory Functions

All resources are created via **async** factory functions that use dynamic imports internally — the provider SDK is only loaded when the function is called with that cloud target. Single cloud target returns a single resource wrapped in a Promise; array target returns an array.

Provider-specific options are passed via the `providerOptions` field on the config object (type: `IProviderOptions`).

```typescript
/** Provider-specific options */
interface IProviderOptions {
  readonly aws?: IAwsProviderOptions;
  readonly azure?: IAzureProviderOptions;
}

interface IAwsProviderOptions {
  readonly fckNatInstanceType?: string;
  readonly availabilityZoneCount?: number;
  readonly autoMode?: boolean;
  readonly addons?: ReadonlyArray<string>;
  readonly endpointAccess?: "public" | "private" | "both";
  readonly stateKmsKeyArn?: string;
  readonly stateForceDestroy?: boolean;
}

interface IAzureProviderOptions {
  readonly resourceGroupName: string; // Required for all Azure resources
  readonly subnetCount?: number;
  readonly azureCni?: boolean;
  readonly virtualNodes?: boolean;
  readonly aadTenantId?: string;
  readonly dnsPrefix?: string;
  readonly tenantId?: string;
  readonly objectId?: string;
  readonly sku?: string;
}

/** Create a network (VPC/VNet) — async, dynamic imports */
async function createNetwork(
  name: string,
  config: INetworkConfig & { providerOptions?: IProviderOptions }
): Promise<INetwork | INetwork[]>;

/** Create a Kubernetes cluster — async, dynamic imports */
async function createCluster(
  name: string,
  config: IClusterConfig & { providerOptions?: IProviderOptions },
  networks: INetwork | INetwork[]
): Promise<ICluster | ICluster[]>;

/** Create a DNS zone — async, dynamic imports */
async function createDns(
  name: string,
  config: IDnsConfig & { providerOptions?: IProviderOptions }
): Promise<IDns | IDns[]>;

/** Create a secrets backend — async, dynamic imports */
async function createSecrets(
  name: string,
  config: ISecretsConfig & { providerOptions?: IProviderOptions }
): Promise<ISecrets | ISecrets[]>;

/** Create a state backend (S3/Azure Blob with BCDR) — async, dynamic imports */
async function createStateBackend(
  name: string,
  config: IStateBackendConfig & { providerOptions?: IProviderOptions }
): Promise<IStateBackend | IStateBackend[]>;

/** Create a database (future) */
async function createDatabase(
  name: string,
  config: IDatabaseConfig & { providerOptions?: IProviderOptions }
): Promise<IDatabase | IDatabase[]>;

/** Create a cache (future) */
async function createCache(
  name: string,
  config: ICacheConfig & { providerOptions?: IProviderOptions }
): Promise<ICache | ICache[]>;

/** Create an object storage bucket (future) */
async function createObjectStorage(
  name: string,
  config: IObjectStorageConfig & { providerOptions?: IProviderOptions }
): Promise<IObjectStorage | IObjectStorage[]>;

/** Create a message queue (future) */
async function createQueue(
  name: string,
  config: IQueueConfig & { providerOptions?: IProviderOptions }
): Promise<IQueue | IQueue[]>;

/** Create a platform stack */
function createPlatformStack(
  name: string,
  config: IPlatformStackConfig
): IPlatformStack | ReadonlyArray<IPlatformStack>;

/** Create a global load balancer */
function createGlobalLoadBalancer(
  name: string,
  config: IGlobalLoadBalancerConfig
): IGlobalLoadBalancer;

/** Create a backup policy (future) */
function createBackupPolicy(
  name: string,
  config: {
    cluster: ICluster;
    schedule: string;
    retentionDays: number;
    target: IObjectStorage;
    namespaces?: ReadonlyArray<string>;
  }
): k8s.helm.v3.Release; // Velero
```

---

## Cross-Cloud Utilities

### CIDR Validation & Auto-Offset

```typescript
/** Validate CIDR doesn't overlap with existing networks */
function validateCidr(cidr: string, existingCidrs: ReadonlyArray<string>): boolean;

/** Auto-generate non-overlapping CIDRs for multi-cloud */
function generateCidrMap(
  baseCidr: string,
  clouds: ReadonlyArray<ResolvedCloudTarget>
): ReadonlyArray<{ cloud: ResolvedCloudTarget; cidr: string }>;
```

### Cross-Cloud Tagging

```typescript
/** Normalize tags across providers */
function normalizeTags(
  tags: Record<string, string>,
  provider: CloudProvider
): Record<string, string>;

/** Required tags (always applied) */
interface IRequiredTags {
  readonly environment: string;
  readonly client: string;
  readonly costCenter: string;
  readonly managedBy: "nimbus";
}
```

**GCP label normalization:** lowercase keys and values, no special characters, max 63 chars.

---

## Usage Examples

### Simple Single-Cloud (ReyemTech on AWS)

```typescript
import { createCluster, createNetwork, createDns, createPlatformStack } from "@reyemtech/nimbus";
import type { INetwork, ICluster, IDns } from "@reyemtech/nimbus";

const network = (await createNetwork("prod", {
  cloud: "aws",
  cidr: "10.0.0.0/16",
  natStrategy: "fck-nat",
})) as INetwork;

const cluster = (await createCluster(
  "prod",
  {
    cloud: "aws",
    nodePools: [
      { name: "system", instanceType: "t3.medium", minNodes: 2, maxNodes: 4 },
      { name: "workers", instanceType: "c6a.large", minNodes: 2, maxNodes: 8, spot: true },
    ],
    providerOptions: { aws: { autoMode: true } },
  },
  network
)) as ICluster;

const dns = (await createDns("prod", {
  cloud: "aws",
  zoneName: "reyem.tech",
})) as IDns;

const platform = createPlatformStack("prod", {
  cluster,
  domain: "reyem.tech",
  externalDns: { dnsProvider: "route53" },
  vault: { enabled: true },
});
```

### Standalone Resources (No Cluster Required)

Factory functions are independent — you can use any abstraction without provisioning a full cluster. For example, to create just a state backend or DNS zone:

```typescript
import { createStateBackend, createDns, createSecrets } from "@reyemtech/nimbus";
import type { IStateBackend, IDns, ISecrets } from "@reyemtech/nimbus";

// State backend — just S3 + DynamoDB, no cluster needed
const state = (await createStateBackend("prod", {
  cloud: "aws",
  versioning: true,
  encryption: true,
  locking: { enabled: true },
})) as IStateBackend;

// DNS zone — standalone
const dns = (await createDns("prod", { cloud: "aws", zoneName: "example.com" })) as IDns;

// Secrets store — standalone
const secrets = (await createSecrets("prod", { cloud: "aws" })) as ISecrets;
```

### Multi-Cloud (BCDR)

```typescript
import type { INetwork, ICluster } from "@reyemtech/nimbus";

const networks = (await createNetwork("prod", {
  cloud: ["aws", "azure"],
  cidr: "10.0.0.0/16",
  providerOptions: { azure: { resourceGroupName: "rg-prod" } },
})) as INetwork[];

const clusters = (await createCluster(
  "prod",
  {
    cloud: [
      { provider: "aws", region: "us-east-1" },
      { provider: "azure", region: "canadacentral" },
    ],
    nodePools: [
      { name: "system", instanceType: "auto", minNodes: 2, maxNodes: 4 },
      { name: "workers", instanceType: "auto", minNodes: 2, maxNodes: 8, spot: true },
    ],
    providerOptions: {
      aws: { autoMode: true },
      azure: { resourceGroupName: "rg-prod" },
    },
  },
  networks
)) as ICluster[];

const glb = createGlobalLoadBalancer("prod", {
  strategy: "active-active",
  clusters,
  domain: "app.example.com",
  healthCheck: { path: "/health", port: 443, protocol: "HTTPS" },
  dnsProvider: "route53",
});
```

### Escape Hatch

```typescript
const cluster = await createCluster("prod", { cloud: "aws", ... }, network) as ICluster;

// Access the native EKS cluster resource
const eksCluster = cluster.nativeResource as aws.eks.Cluster;
eksCluster.arn.apply(arn => console.log("EKS ARN:", arn));
```
