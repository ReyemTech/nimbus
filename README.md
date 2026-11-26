# @reyemtech/nimbus

[![npm version](https://img.shields.io/npm/v/@reyemtech/nimbus.svg)](https://www.npmjs.com/package/@reyemtech/nimbus)
[![CI](https://github.com/reyemtech/nimbus/actions/workflows/ci.yml/badge.svg)](https://github.com/reyemtech/nimbus/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Nimbus is a TypeScript toolkit for reusable Pulumi infrastructure across AWS, Azure, Rackspace Spot, and Kubernetes. It provides provider-aware factories for networks, clusters, DNS, secrets, platform services, observability, and application infrastructure.

## Install

```bash
npm install @reyemtech/nimbus
npx @reyemtech/nimbus install aws # or azure
```

Each release includes an SPDX SBOM (`nimbus.spdx.json`) and npm provenance.

## Quick start

```typescript
import {
  createNetwork,
  createCluster,
  type IClusterWithFluentOperations,
  type INetwork,
} from "@reyemtech/nimbus";

const network = await createNetwork("prod", {
  cloud: "aws",
  cidr: "10.0.0.0/16",
  natStrategy: "managed",
});

const cluster = createCluster(
  "prod",
  {
    cloud: "aws",
    nodePools: [{ name: "system", instanceType: "t4g.large", minNodes: 2, maxNodes: 4 }],
  },
  network as INetwork
) as IClusterWithFluentOperations;

const access = cluster.createServiceAccountAccess("ci-reader", {
  scope: { type: "namespace", namespace: "apps", role: "view" },
});
export const ciKubeconfig = access.kubeconfig;
```

For a scaffolded project, run `npx @reyemtech/nimbus new my-infra aws`.

## Documentation

Start at the [documentation index](docs/README.md). It links to [provider guides](docs/providers/), [examples](docs/examples.md), [Kubernetes access](docs/guides/kubernetes-access.md), and the [API reference](docs/api-reference.md). AWS EKS users can also see the [private Route 53 and Ingress visibility guide](docs/providers/aws.md#private-route-53-zones-and-ingress-dns-visibility).

## Development

```bash
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

See the [changelog](CHANGELOG.md) for release history.
