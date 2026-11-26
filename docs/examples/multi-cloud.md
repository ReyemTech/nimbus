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

Full example: [`examples/multi-cloud/`](../../examples/multi-cloud/)
