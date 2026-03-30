/**
 * Multi-cloud example — AWS + Azure active-active deployment.
 *
 * Demonstrates: Factory API, auto-CIDR, dual-cloud provisioning, Global Load Balancer
 * With the factory API, switching clouds = change the `cloud` array.
 *
 * Usage:
 *   pulumi new typescript
 *   npm install @reyemtech/nimbus
 *   # Copy this file to index.ts
 *   pulumi up
 */

import {
  createNetwork,
  createCluster,
  createDns,
  createPlatformStack,
  createGlobalLoadBalancer,
} from "@reyemtech/nimbus";
import type { INetwork, ICluster, IDns } from "@reyemtech/nimbus";

const resourceGroupName = "rg-prod-canadacentral";

// Shared provider options
const providerOptions = {
  aws: { autoMode: true },
  azure: { resourceGroupName },
};

// 1. Networks — Auto-offset CIDRs: AWS gets 10.0.0.0/16, Azure gets 10.1.0.0/16
const networks = createNetwork("prod", {
  cloud: [
    { provider: "aws", region: "us-east-1" },
    { provider: "azure", region: "canadacentral" },
  ],
  cidr: "10.0.0.0/16",
  natStrategy: "fck-nat", // AWS uses fck-nat, Azure falls back to managed
  providerOptions,
}) as INetwork[];

// 2. Clusters — Networks are auto-matched by provider
const clusters = createCluster(
  "prod",
  {
    cloud: [
      { provider: "aws", region: "us-east-1" },
      { provider: "azure", region: "canadacentral" },
    ],
    version: "1.32",
    nodePools: [
      { name: "system", instanceType: "t4g.small", minNodes: 2, maxNodes: 3 },
      {
        name: "workers",
        instanceType: "c6a.large",
        minNodes: 2,
        maxNodes: 8,
        spot: true,
      },
    ],
    providerOptions,
  },
  networks
) as ICluster[];

// 3. DNS — Route 53 hosted zone
const dns = createDns("prod", {
  cloud: "aws",
  zoneName: "example.com",
}) as IDns;

// 4. Platform Stack — Deploy to both clusters
createPlatformStack("prod", {
  cluster: clusters,
  domain: "example.com",
  externalDns: {
    dnsProvider: "route53",
    domainFilters: ["example.com"],
  },
});

// 5. Global Load Balancer — Active-active across both clouds
const glb = createGlobalLoadBalancer("prod", {
  strategy: "active-active",
  clusters,
  domain: "app.example.com",
  healthCheck: {
    path: "/health",
    port: 443,
    protocol: "HTTPS",
    intervalSeconds: 30,
    unhealthyThreshold: 3,
  },
  dnsProvider: "route53",
});

// Stack outputs
export const awsVpcId = networks[0]?.vpcId;
export const azureVnetId = networks[1]?.vpcId;
export const awsEndpoint = clusters[0]?.endpoint;
export const azureEndpoint = clusters[1]?.endpoint;
export const glbEndpoint = glb.endpoint;
export const glbStrategy = glb.strategy;
export const dnsZoneId = dns.zoneId;
