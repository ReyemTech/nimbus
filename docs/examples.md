# Examples

Usage examples for common nimbus patterns. See the [`examples/`](../examples/) directory for complete, runnable projects.

## Single Cloud (AWS)

```typescript
import { createNetwork, createCluster, createDns, createPlatformStack } from "@reyemtech/nimbus";
import type { INetwork, ICluster, IDns } from "@reyemtech/nimbus";

// Network with fck-nat (~$3/mo)
const network = (await createNetwork("prod", {
  cloud: "aws",
  cidr: "10.0.0.0/16",
  natStrategy: "fck-nat",
})) as INetwork;

// EKS cluster with Auto Mode
const cluster = (await createCluster(
  "prod",
  {
    cloud: "aws",
    nodePools: [
      { name: "system", instanceType: "t4g.small", minNodes: 2, maxNodes: 3 },
      { name: "workers", instanceType: "c6a.large", minNodes: 1, maxNodes: 10, spot: true },
    ],
    providerOptions: { aws: { autoMode: true } },
  },
  network
)) as ICluster;

// DNS zone
const dns = (await createDns("prod", { cloud: "aws", zoneName: "example.com" })) as IDns;

// Platform stack (Traefik, cert-manager, External DNS, ArgoCD, Vault)
createPlatformStack("prod", {
  cluster,
  domain: "example.com",
  externalDns: { dnsProvider: "route53", domainFilters: ["example.com"] },
  vault: { enabled: true, ingressHost: "vault.example.com" },
});
```

Full example: [`examples/single-cloud-aws/`](../examples/single-cloud-aws/)

## Single Cloud (Azure)

```typescript
import { createNetwork, createCluster, createDns, createPlatformStack } from "@reyemtech/nimbus";
import type { INetwork, ICluster } from "@reyemtech/nimbus";

const providerOptions = { azure: { resourceGroupName: "rg-prod" } };

const network = (await createNetwork("prod", {
  cloud: "azure",
  cidr: "10.1.0.0/16",
  natStrategy: "managed",
  providerOptions,
})) as INetwork;

const cluster = (await createCluster(
  "prod",
  {
    cloud: "azure",
    nodePools: [
      { name: "system", instanceType: "Standard_D2s_v5", minNodes: 2, maxNodes: 3, mode: "system" },
      {
        name: "workers",
        instanceType: "Standard_D4s_v5",
        minNodes: 1,
        maxNodes: 10,
        spot: true,
        mode: "user",
      },
    ],
    virtualNodes: true,
    providerOptions,
  },
  network
)) as ICluster;

createPlatformStack("prod", {
  cluster,
  domain: "example.com",
  externalDns: { dnsProvider: "azure-dns", domainFilters: ["example.com"] },
});
```

Full example: [`examples/single-cloud-azure/`](../examples/single-cloud-azure/)

## Multi-Cloud (AWS + Azure)

```typescript
import { createNetwork, createCluster, createGlobalLoadBalancer } from "@reyemtech/nimbus";
import type { INetwork, ICluster } from "@reyemtech/nimbus";

const providerOptions = {
  aws: { autoMode: true },
  azure: { resourceGroupName: "rg-prod" },
};

// Auto-offsets CIDRs: AWS gets 10.0.0.0/16, Azure gets 10.1.0.0/16
const networks = (await createNetwork("prod", {
  cloud: ["aws", "azure"],
  cidr: "10.0.0.0/16",
  natStrategy: "fck-nat",
  providerOptions,
})) as INetwork[];

// Networks auto-matched by provider
const clusters = (await createCluster(
  "prod",
  {
    cloud: ["aws", "azure"],
    nodePools: [
      { name: "system", instanceType: "t4g.small", minNodes: 2, maxNodes: 3 },
      { name: "workers", instanceType: "c6a.large", minNodes: 2, maxNodes: 8, spot: true },
    ],
    providerOptions,
  },
  networks
)) as ICluster[];

// Global Load Balancer — active-active across both clouds
const glb = createGlobalLoadBalancer("prod", {
  strategy: "active-active",
  clusters,
  domain: "app.example.com",
  healthCheck: { path: "/health", port: 443, protocol: "HTTPS" },
  dnsProvider: "route53",
});
```

Full example: [`examples/multi-cloud/`](../examples/multi-cloud/)

## Standalone Resources (No Cluster Required)

Every factory function is independent — you don't need a cluster to create a state backend, DNS zone, secrets store, or network:

```typescript
import { createStateBackend, createDns, createSecrets, createNetwork } from "@reyemtech/nimbus";
import type { IStateBackend, IDns, ISecrets, INetwork } from "@reyemtech/nimbus";

// Just an S3 bucket for state — no cluster, no platform stack
const state = (await createStateBackend("prod", {
  cloud: "aws",
  versioning: true,
  encryption: true,
  locking: { enabled: true },
})) as IStateBackend;

// Just a DNS zone
const dns = (await createDns("prod", {
  cloud: "azure",
  zoneName: "example.com",
  providerOptions: { azure: { resourceGroupName: "rg-dns" } },
})) as IDns;

// Just a secrets store
const secrets = (await createSecrets("prod", { cloud: "aws" })) as ISecrets;

// Just a network (for non-K8s workloads like EC2, Lambda, etc.)
const network = (await createNetwork("prod", {
  cloud: "aws",
  cidr: "10.0.0.0/16",
  natStrategy: "managed",
})) as INetwork;
```

Full examples: [`examples/minimal-aws/`](../examples/minimal-aws/) | [`examples/minimal-azure/`](../examples/minimal-azure/)

## State Backend (BCDR)

```typescript
import { createStateBackend } from "@reyemtech/nimbus";
import type { IStateBackend } from "@reyemtech/nimbus";

// S3 state backend with versioning, encryption, locking, and cross-region replication
const state = (await createStateBackend("prod", {
  cloud: "aws",
  versioning: true,
  encryption: true,
  locking: { enabled: true },
  replication: { enabled: true, destinationRegion: "us-west-2" },
})) as IStateBackend;

// Use the backend URL with `pulumi login`
// state.backendUrl => "s3://prod-state-xxxxx"

// Azure state backend
const azureState = (await createStateBackend("prod", {
  cloud: "azure",
  versioning: true,
  replication: { enabled: true }, // Uses Standard_GRS SKU
  providerOptions: { azure: { resourceGroupName: "rg-state" } },
})) as IStateBackend;
```
