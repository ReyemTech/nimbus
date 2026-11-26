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

Full example: [`examples/single-cloud-azure/`](../../examples/single-cloud-azure/)
