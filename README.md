# @reyemtech/nimbus

[![npm version](https://img.shields.io/npm/v/@reyemtech/nimbus.svg)](https://www.npmjs.com/package/@reyemtech/nimbus)
[![CI](https://github.com/reyemtech/nimbus/actions/workflows/ci.yml/badge.svg)](https://github.com/reyemtech/nimbus/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/badge/coverage-%3E80%25-brightgreen)](https://github.com/reyemtech/nimbus)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org/)
[![Pulumi](https://img.shields.io/badge/Pulumi-%E2%89%A53.0-blueviolet.svg)](https://www.pulumi.com/)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A520-green.svg)](https://nodejs.org/)

Cloud-agnostic infrastructure abstractions for [Pulumi](https://www.pulumi.com/). Write IaC once, deploy to AWS, Azure, or both. Cloud migration = change one config value.

## Why

Every client environment follows the same pattern: network + cluster + DNS + secrets + platform. The only difference is the cloud provider. Nimbus extracts that pattern into reusable, type-safe factory functions.

- **Cloud migration in one line** — change `cloud: "aws"` to `cloud: "azure"`
- **Multi-cloud active-active** — deploy to AWS + Azure with a Global Load Balancer
- **Dynamic provider loading** — only the targeted SDK loads; missing providers give install instructions
- **Cost-optimized defaults** — fck-nat (~$3/mo vs $32/mo), spot instances, Auto Mode
- **Escape hatches** — every resource exposes `nativeResource` for cloud-specific access

## Install

```bash
npm install @reyemtech/nimbus
```

Install provider SDKs for your target cloud(s):

```bash
npx @reyemtech/nimbus install aws          # @pulumi/aws
npx @reyemtech/nimbus install azure        # @pulumi/azure-native
npx @reyemtech/nimbus install aws azure    # both
```

Each published release includes an SPDX SBOM named `nimbus.spdx.json` in both
the npm package and GitHub Release assets. It is generated from the release
lockfile with development dependencies omitted. npm provenance is also enabled
for published packages.

## Quick Start

Scaffold a new project (handles `pulumi new`, `npm install`, and provider setup):

```bash
npx @reyemtech/nimbus new my-infra aws
cd my-infra
pulumi up
```

Or start from scratch:

```typescript
import { createNetwork, createCluster, createPlatformStack } from "@reyemtech/nimbus";
import type { INetwork, ICluster } from "@reyemtech/nimbus";

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
      { name: "system", instanceType: "t4g.small", minNodes: 2, maxNodes: 3 },
      { name: "workers", instanceType: "c6a.large", minNodes: 1, maxNodes: 10, spot: true },
    ],
    providerOptions: { aws: { autoMode: true } },
  },
  network
)) as ICluster;

createPlatformStack("prod", { cluster, domain: "example.com" });
```

See [docs/examples.md](docs/examples.md) for Azure, multi-cloud, and standalone resource patterns.

## Rackspace cluster modes

Rackspace-managed mode remains the default: Nimbus looks up the Cloudspace,
creates Spot node pools, and retrieves kubeconfig.

```typescript
// Managed Rackspace Spot cluster (the default).
const managed = createCluster("prod", {
  cloud: "rackspace",
  nodePools: [{ name: "workers", instanceType: "gp.vs1.xlarge-iad", minNodes: 2, maxNodes: 3, bidPrice: 0.04 }],
  providerOptions: { rackspace: { cloudspaceName: "reyemtech2" } },
});
```

To connect to a separately managed existing cluster with no Rackspace calls or
resources, use `mode: "existing-cluster"`:

```typescript
const attached = createCluster("prod", {
  cloud: "rackspace",
  nodePools: [],
  providerOptions: {
    rackspace: {
      mode: "existing-cluster",
      kubeconfig: process.env.KUBECONFIG_CONTENT,
      kubeconfigContext: "production",
    },
  },
});
```

After the managed cluster is running, keep `mode` unset (or `"managed"`) and
switch only Kubernetes authentication. Rackspace node pools stay registered in
the stack. Use a Pulumi config value to select the kubeconfig:

```typescript
import * as pulumi from "@pulumi/pulumi";

const useExistingCluster = new pulumi.Config().getBoolean("useExistingCluster") ?? false;
const connected = createCluster("prod", {
  cloud: "rackspace",
  nodePools: [{ name: "workers", instanceType: "gp.vs1.xlarge-iad", minNodes: 2, maxNodes: 3, bidPrice: 0.04 }],
  providerOptions: {
    rackspace: useExistingCluster
      ? { cloudspaceName: "reyemtech2", kubeconfig: new pulumi.Config().require("kubeconfig") }
      : { cloudspaceName: "reyemtech2" },
  },
});
```

For an in-cluster Pulumi run, set `useInClusterConfig: true` instead of
`kubeconfig`. Do not set both.

When a supplied kubeconfig contains multiple contexts, set
`kubeconfigContext` to the desired context name. It defaults to the kubeconfig's
`current-context`, and Nimbus derives `cluster.endpoint` from that same context.

For AWS-only Pulumi targets, use Nimbus's provider-specific AWS entry points and
omit `createCluster()`. This avoids registering Rackspace or Kubernetes
providers while retaining Nimbus's AWS network, secrets, DNS, and state helpers:

```typescript
import { createAwsNetwork, createAwsSecrets } from "@reyemtech/nimbus/aws";

const network = createAwsNetwork("prod", { cloud: "aws", cidr: "10.0.0.0/16" });
const secrets = createAwsSecrets("prod", { cloud: "aws", backend: "aws-secrets-manager" });
```

### Pulumi state ownership when switching modes

For a same-stack credential transition, leave `mode` unset or set it to
`"managed"`, and change only `kubeconfig` or `useInClusterConfig`. Spot node
pools remain registered under the same logical names, so Pulumi continues to
own them. The Kubernetes provider configuration may be updated; review its
preview. Workloads remain tracked in the same stack.

Setting `mode: "existing-cluster"` has different ownership semantics: Nimbus
does not query Rackspace or register Spot resources. If you switch a stack that
currently manages Spot node pools to that mode, Pulumi will plan to delete those
node pools. The Cloudspace lookup is a data source and is not owned in state.

Use `mode: "existing-cluster"` in a separate workload stack, or transfer/import
Spot resources and review the preview before changing ownership modes in one
stack. Switching back to managed mode requires preserving/importing the node-pool
state under its logical names to avoid replacement or duplicate resources.

## CLI

```bash
nimbus new <name> <template>     # Scaffold a project from a template
nimbus install <provider> [...]  # Install cloud provider SDKs
nimbus check                     # Show which providers are installed
```

### Templates

| Template        | Description                                               |
| --------------- | --------------------------------------------------------- |
| `empty`         | Blank scaffold with TODO placeholders                     |
| `minimal-aws`   | State backend + Secrets Manager (no cluster)              |
| `minimal-azure` | State backend + Key Vault (no cluster)                    |
| `aws`           | Full stack: VPC + EKS + Route 53 + Secrets + Platform     |
| `azure`         | Full stack: VNet + AKS + Azure DNS + Key Vault + Platform |
| `multi-cloud`   | AWS + Azure active-active with Global Load Balancer       |

### Day-to-Day Operations

After scaffolding, use standard Pulumi commands to manage your infrastructure:

```bash
pulumi preview    # Preview changes before deploying
pulumi up         # Deploy infrastructure
pulumi refresh    # Sync state with actual cloud resources
pulumi destroy    # Tear down all resources
pulumi config set key value   # Set stack configuration
pulumi stack output           # View stack outputs
```

## Architecture

```
@reyemtech/nimbus
├── factories/      # Cloud-agnostic factory functions (primary API)
├── types/          # CloudProvider, CloudTarget, tags, errors, validation
├── network/        # VPC (AWS), VNet (Azure) + NAT + CIDR utilities
├── cluster/        # EKS, AKS (+ Auto Mode, virtual nodes, spot)
├── dns/            # Route 53, Azure DNS
├── secrets/        # AWS Secrets Manager, Azure Key Vault
├── state/          # Pulumi state backend (S3, Azure Blob) with BCDR
├── platform/       # Helm: Traefik, cert-manager, External DNS, ArgoCD, Vault, ESO
├── global-lb/      # DNS-based multi-cloud routing (active-active, failover, geo)
├── cli.ts          # CLI (nimbus new/install/check)
├── cli/            # CLI templates for project scaffolding
├── database/       # (interfaces only — RDS, Azure DB, PXC, CNPG)
├── cache/          # (interfaces only — ElastiCache, Azure Cache, Redis Helm)
├── storage/        # (interfaces only — S3, Blob, GCS)
└── queue/          # (interfaces only — SQS, Service Bus, NATS)
```

### Module Status

| Module        | AWS                                 | Azure                    | GCP                      |
| ------------- | ----------------------------------- | ------------------------ | ------------------------ |
| **Network**   | VPC + fck-nat/managed NAT           | VNet + NAT Gateway       | Planned                  |
| **Cluster**   | EKS + Auto Mode                     | AKS + virtual nodes      | Planned                  |
| **DNS**       | Route 53                            | Azure DNS                | Planned                  |
| **Secrets**   | Secrets Manager                     | Key Vault                | Planned                  |
| **State**     | S3 + DynamoDB locking + replication | Blob + GRS               | Planned                  |
| **Platform**  | Helm (provider-agnostic)            | Helm (provider-agnostic) | Helm (provider-agnostic) |
| **Global LB** | Route 53 health-checked routing     | Planned                  | —                        |

## Documentation

- [API Reference](docs/api-reference.md) — Factory functions, provider options, direct cloud functions
- [Examples](docs/examples.md) — Single-cloud, multi-cloud, standalone resources, BCDR
- [Utilities](docs/utilities.md) — CIDR helpers, validation, tags, error handling
- [CNPG Declarative Databases](docs/cnpg-declarative-databases.md) — Migrating PostgreSQL databases from bootstrap Jobs to `Database`/`DatabaseRole` CRDs
- [v3 Migration Guide](docs/migrations/v3.md) — Upgrading to `addRole()`, the `superuserAccess` default change, and the `migrate v3` pre-flight check

## Development

```bash
npm install
npm run typecheck      # Type checking
npm run lint           # ESLint
npm run format         # Prettier
npm test               # Vitest (unit tests)
npm run test:coverage  # With 80% coverage thresholds
npm run build          # ESM + CJS dual build
npm run docs:api       # TypeDoc API docs
```

## License

MIT
