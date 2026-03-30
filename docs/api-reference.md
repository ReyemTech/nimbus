# API Reference

Full reference for all nimbus factory functions, provider options, and escape hatches.

## Factory Functions (Primary API)

The factory functions are the recommended way to use this library. They dispatch to the correct cloud-specific implementation based on the `cloud` parameter. Provider-specific options are passed via `providerOptions`.

All factory functions are **async** and use dynamic imports internally — the provider SDK is only loaded when the function is called with that cloud target.

### `createNetwork(name, config)`

Creates a VPC (AWS) or VNet (Azure) with subnets and NAT.

| Parameter                | Type               | Description                                               |
| ------------------------ | ------------------ | --------------------------------------------------------- |
| `name`                   | `string`           | Resource name prefix                                      |
| `config.cloud`           | `CloudArg`         | `"aws"`, `"azure"`, or `["aws", "azure"]` for multi-cloud |
| `config.cidr`            | `string`           | CIDR block (auto-offset for multi-cloud)                  |
| `config.natStrategy`     | `NatStrategy`      | `"managed"`, `"fck-nat"`, or `"none"`                     |
| `config.providerOptions` | `IProviderOptions` | Provider-specific options (see below)                     |

Returns: `Promise<INetwork>` (single cloud) or `Promise<INetwork[]>` (multi-cloud)

### `createCluster(name, config, networks)`

Creates an EKS (AWS) or AKS (Azure) cluster.

| Parameter                | Type                     | Description                                           |
| ------------------------ | ------------------------ | ----------------------------------------------------- |
| `config.nodePools`       | `INodePool[]`            | Node pool definitions                                 |
| `config.version`         | `string`                 | Kubernetes version                                    |
| `config.providerOptions` | `IProviderOptions`       | Provider-specific options                             |
| `networks`               | `INetwork \| INetwork[]` | Network(s) — auto-matched by provider for multi-cloud |

Returns: `Promise<ICluster>` (single cloud) or `Promise<ICluster[]>` (multi-cloud)

### `createDns(name, config)`

Creates a Route 53 (AWS) or Azure DNS zone.

Returns: `Promise<IDns>` (single cloud) or `Promise<IDns[]>` (multi-cloud)

### `createSecrets(name, config)`

Creates an AWS Secrets Manager or Azure Key Vault store.

```typescript
const secrets = (await createSecrets("prod", { cloud: "aws" })) as ISecrets;
secrets.putSecret("database", { host: "db.example.com", password: dbPassword });
const pw = secrets.getSecretRef({ path: "database", key: "password" });
```

Returns: `Promise<ISecrets>` (single cloud) or `Promise<ISecrets[]>` (multi-cloud)

### `createStateBackend(name, config)`

Creates an S3 bucket (AWS) or Azure Storage Account for Pulumi state with BCDR features.

| Parameter            | Type                 | Description                                              |
| -------------------- | -------------------- | -------------------------------------------------------- |
| `config.versioning`  | `boolean`            | Enable bucket/container versioning. Default: `true`      |
| `config.encryption`  | `boolean`            | Enable server-side encryption. Default: `true`           |
| `config.locking`     | `IStateLockConfig`   | State locking config (DynamoDB on AWS). Default: enabled |
| `config.replication` | `IReplicationConfig` | Cross-region replication. Default: disabled              |

Returns: `Promise<IStateBackend>` (single cloud) or `Promise<IStateBackend[]>` (multi-cloud)

**AWS features:** S3 BucketV2, public access block, versioning, SSE (AES256 or KMS), DynamoDB locking, cross-region replication with IAM.

**Azure features:** StorageAccount (StorageV2, HTTPS-only, TLS 1.2), BlobContainer, versioning, GRS for geo-replication. Azure blob leases handle locking natively.

### `createPlatformStack(name, config)`

Deploys Helm-based platform components to one or more clusters.

| Component        | Default       | Chart                                       |
| ---------------- | ------------- | ------------------------------------------- |
| Traefik          | Enabled       | `traefik/traefik` v34.3.0                   |
| cert-manager     | Enabled       | `jetstack/cert-manager` v1.17.2             |
| External DNS     | If configured | `kubernetes-sigs/external-dns` v1.16.1      |
| ArgoCD           | Disabled      | `argoproj/argo-cd` v7.8.26                  |
| Vault            | Disabled      | `hashicorp/vault` v0.29.1                   |
| External Secrets | Disabled      | `external-secrets/external-secrets` v0.14.4 |

### `createGlobalLoadBalancer(name, config)`

Routes traffic across clusters using DNS-based health checks.

| Strategy         | Behavior                                                 |
| ---------------- | -------------------------------------------------------- |
| `active-active`  | Weighted routing — equal traffic to all healthy clusters |
| `active-passive` | Failover — primary cluster, secondary on failure         |
| `geo`            | Geolocation — route by client continent                  |

## Provider Options

```typescript
providerOptions: {
  aws: {
    // Network
    fckNatInstanceType: "t4g.nano",
    availabilityZoneCount: 2,
    // Cluster
    autoMode: true,
    addons: ["vpc-cni", "coredns"],
    endpointAccess: "both",
    // State backend
    stateKmsKeyArn: "arn:aws:kms:...",
    stateForceDestroy: false,
  },
  azure: {
    resourceGroupName: "my-rg",  // Required for all Azure resources
    // Network
    subnetCount: 2,
    // Cluster
    azureCni: true,
    virtualNodes: false,
    aadTenantId: "...",
    dnsPrefix: "...",
    // Secrets
    tenantId: "...",             // Required for Key Vault
    objectId: "...",
    sku: "standard",
  },
}
```

## Cloud Target Flexibility

All factory functions accept flexible cloud arguments:

```typescript
// String shorthand (uses DEFAULT_REGIONS)
await createNetwork("prod", { cloud: "aws", ... });

// Explicit target
await createNetwork("prod", { cloud: { provider: "aws", region: "eu-west-1" }, ... });

// Multi-cloud array
await createNetwork("prod", { cloud: ["aws", "azure"], ... });
```

## Direct Cloud Functions (Escape Hatch)

For maximum control, use cloud-specific functions directly via subpath imports:

```typescript
import { createAwsNetwork, createEksCluster } from "@reyemtech/nimbus/aws";
import { createAzureNetwork, createAksCluster } from "@reyemtech/nimbus/azure";
```

Available functions:

- `createAwsNetwork(name, config, options?)` / `createAzureNetwork(name, config, options)`
- `createEksCluster(name, config, network, options?)` / `createAksCluster(name, config, network, options)`
- `createRoute53Dns(name, config)` / `createAzureDns(name, config, options)`
- `createAwsSecrets(name, config)` / `createAzureSecrets(name, config, options)`
- `createAwsStateBackend(name, config, options?)` / `createAzureStateBackend(name, config, options)`

## Escape Hatches

Every resource exposes its cloud-native object via `nativeResource`:

```typescript
import * as aws from "@pulumi/aws";

const cluster = await createCluster("prod", { cloud: "aws", ... }, network) as ICluster;
const eksCluster = cluster.nativeResource as aws.eks.Cluster;
eksCluster.arn.apply(arn => console.log("EKS ARN:", arn));
```
