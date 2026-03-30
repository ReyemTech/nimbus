# Migration Guide: Single-Cloud to Multi-Cloud

How to evolve a `@reyemtech/nimbus` deployment from single-cloud to multi-cloud active-active.

## Phase 1: Single Cloud (Starting Point)

You have a standard single-cloud deployment using the factory functions:

```typescript
import { createNetwork, createCluster, createDns, createPlatformStack } from "@reyemtech/nimbus";
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
      { name: "system", instanceType: "t4g.small", minNodes: 2, maxNodes: 3 },
      { name: "workers", instanceType: "c6a.large", minNodes: 2, maxNodes: 8, spot: true },
    ],
    providerOptions: { aws: { autoMode: true } },
  },
  network
)) as ICluster;

const dns = (await createDns("prod", { cloud: "aws", zoneName: "example.com" })) as IDns;

createPlatformStack("prod", {
  cluster,
  domain: "example.com",
  externalDns: { dnsProvider: "route53", domainFilters: ["example.com"] },
});
```

> **Note:** All factory functions are **async** and use dynamic imports — only the provider SDK you target is loaded at runtime. If you don't have `@pulumi/aws` installed, the import error surfaces when you call a factory with `cloud: "aws"`, not at import time. Install providers with `npx @reyemtech/nimbus install aws`.

## Phase 2: Add CIDR Planning

Before adding a second cloud, set up CIDR planning so VPCs don't overlap (required for peering/mesh):

```diff
+import { buildCidrMap } from "@reyemtech/nimbus";
+
+// Plan CIDRs for current + future clouds
+const cidrs = buildCidrMap(["aws", "azure"]);
+// => { aws: "10.0.0.0/16", azure: "10.1.0.0/16" }

 const network = await createNetwork("prod", {
   cloud: "aws",
-  cidr: "10.0.0.0/16",
+  cidr: cidrs["aws"],  // "10.0.0.0/16"
   natStrategy: "fck-nat",
- });
+ }) as INetwork;
```

This is a no-op change if your existing CIDR was already `10.0.0.0/16`. The benefit: `buildCidrMap` validates no overlaps and reserves the Azure range.

## Phase 3: Add Second Cloud

Add the Azure infrastructure alongside AWS using the same factory functions — just change the `cloud` target:

```diff
+const providerOptions = { azure: { resourceGroupName: "rg-prod-canadacentral" } };
+
+// Azure network (same factory, different cloud target)
+const azureNetwork = await createNetwork("prod-azure", {
+  cloud: { provider: "azure", region: "canadacentral" },
+  cidr: cidrs["azure"],  // "10.1.0.0/16"
+  natStrategy: "managed",
+  providerOptions,
+}) as INetwork;
+
+// Azure cluster
+const azureCluster = await createCluster("prod-azure", {
+  cloud: { provider: "azure", region: "canadacentral" },
+  nodePools: [
+    { name: "system", instanceType: "Standard_D2s_v5", minNodes: 2, maxNodes: 3, mode: "system" },
+    { name: "workers", instanceType: "Standard_D4s_v5", minNodes: 2, maxNodes: 8, spot: true, mode: "user" },
+  ],
+  providerOptions,
+}, azureNetwork) as ICluster;
```

> **Tip:** You can also use subpath imports for direct access: `import { createAzureNetwork } from "@reyemtech/nimbus/azure"`

At this point you have two independent clusters. Run `pulumi up` to provision Azure resources.

## Phase 4: Deploy Platform to Both Clusters

Update the platform stack to deploy to both clusters:

```diff
 createPlatformStack("prod", {
-  cluster,
+  cluster: [cluster, azureCluster],
   domain: "example.com",
   externalDns: { dnsProvider: "route53", domainFilters: ["example.com"] },
 });
```

This deploys Traefik, cert-manager, External DNS, and any other enabled components to both clusters.

## Phase 5: Add Global Load Balancer

Route traffic across both clusters:

```diff
+import { createGlobalLoadBalancer } from "@reyemtech/nimbus";
+
+const glb = createGlobalLoadBalancer("prod", {
+  strategy: "active-active",
+  clusters: [cluster, azureCluster],
+  domain: "app.example.com",
+  healthCheck: {
+    path: "/health",
+    port: 443,
+    protocol: "HTTPS",
+  },
+  dnsProvider: "route53",
+});
+
+export const glbEndpoint = glb.endpoint;
```

### Routing Strategies

| Strategy         | When to use                                                                   |
| ---------------- | ----------------------------------------------------------------------------- |
| `active-active`  | Both clusters serve traffic (weighted equal). Best for redundancy + capacity. |
| `active-passive` | Primary cluster handles all traffic; Azure is standby. Best for cost savings. |
| `geo`            | Route by client geography. Best for latency-sensitive apps.                   |

Start with `active-passive` if you want BCDR without doubling costs, then switch to `active-active` when ready.

## Phase 6: Validation (Optional)

Add validation to catch misconfigurations early:

```typescript
import { validateMultiCloud, assertValidMultiCloud } from "@reyemtech/nimbus";

// Check for duplicate targets, naming issues
const result = validateMultiCloud(
  [
    { provider: "aws", region: "us-east-1" },
    { provider: "azure", region: "canadacentral" },
  ],
  "prod"
);

console.log(result.warnings); // e.g., naming restrictions per provider

// Or throw on errors
assertValidMultiCloud(
  [
    { provider: "aws", region: "us-east-1" },
    { provider: "azure", region: "canadacentral" },
  ],
  "prod"
);
```

## Rollback

Each phase is independently deployable and reversible:

- **Remove GLB**: Delete the `createGlobalLoadBalancer` call, `pulumi up`
- **Remove second cloud**: Delete the Azure resources, `pulumi up` (Azure infra is destroyed)
- **Revert CIDR planning**: Change `cidrs["aws"]` back to `"10.0.0.0/16"`

The key principle: **multi-cloud is additive**. Your existing single-cloud stack continues to work unchanged throughout the migration.
