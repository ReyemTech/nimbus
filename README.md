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
