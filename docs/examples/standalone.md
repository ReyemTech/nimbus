## Standalone Resources (No Cluster Required)

## Pod disruption budget

Supported controllers default to voluntary eviction protection: one replica uses `minAvailable: 1`, and multiple replicas use `maxUnavailable: 1`. A singleton policy can block node drains and autoscaler scale-in until a replacement is ready. For planned maintenance, set `podDisruptionBudget: { enabled: false }` on the affected component and restore protection afterward.

```typescript
const operator = createOperator("cloudnative-pg", {
  cluster,
  podDisruptionBudget: { enabled: true }, // database operator controller
});
const pg = operator.createCluster("orders", {
  replicas: 3,
  scheduling: { spread: { strategy: "topology-spread", mode: "preferred" } },
});
```

`minAvailable` and `maxUnavailable` are mutually exclusive and accept a nonnegative integer or percentage. Nimbus preserves replica defaults and does not scale a workload up automatically. CloudNativePG and MariaDB Operator own database workload budgets through their CRDs; Nimbus does not create duplicate standalone PDBs for them. Nimbus creates a standalone PDB for MinIO Tenant workloads because the targeted MinIO Tenant controller does not reconcile one. CNPG only exposes its native enable/disable switch. Neo4j has no separate operator-controller availability settings, while `createCluster()` supports workload PDB and scheduling spread. Jobs, CronJobs, and DaemonSets have no Nimbus PDB; the Descheduler remains a CronJob. EKS add-ons are configurable only when their version-matched AWS schema supports a native PDB and no existing budget conflicts. PDBs cover voluntary evictions, not node or zone failure.

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

Full examples: [`examples/minimal-aws/`](../../examples/minimal-aws/) | [`examples/minimal-azure/`](../../examples/minimal-azure/)

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

## Portable Kubernetes ServiceAccount kubeconfig

Use the standalone API with any `ICluster`, including a caller-constructed cluster object:

```typescript
import { createServiceAccountAccess } from "@reyemtech/nimbus";

const access = createServiceAccountAccess("release-bot", {
  cluster,
  scope: { type: "namespace", namespace: "apps", role: "edit" },
});

export const releaseBotKubeconfig = access.kubeconfig;
```

See the [Kubernetes access guide](../guides/kubernetes-access.md) for scopes, export commands, and revocation.
