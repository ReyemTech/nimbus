/**
 * Single-cloud AWS example — deploys a full stack on AWS.
 *
 * Demonstrates: VPC + EKS + Route 53 + Secrets Manager + Platform Stack
 * Uses the factory API for cloud-agnostic code.
 *
 * Usage:
 *   pulumi new typescript
 *   npm install @reyemtech/nimbus
 *   # Copy this file to index.ts
 *   pulumi up
 */

import {
  createAccessGateway,
  createNetwork,
  createCluster,
  createDns,
  createSecrets,
  createPlatformStack,
} from "@reyemtech/nimbus";
import type { INetwork, ICluster, IDns, ISecrets } from "@reyemtech/nimbus";
import * as pulumi from "@pulumi/pulumi";

// 1. Network — VPC with fck-nat (~$3/mo vs $32/mo managed NAT)
const network = createNetwork("prod", {
  cloud: "aws",
  cidr: "10.0.0.0/16",
  natStrategy: "fck-nat",
  tags: { environment: "production", client: "acme" },
  providerOptions: {
    aws: { fckNatInstanceType: "t4g.nano", availabilityZoneCount: 2 },
  },
}) as INetwork;

// 2. Cluster — EKS with Auto Mode
const cluster = createCluster(
  "prod",
  {
    cloud: "aws",
    version: "1.32",
    nodePools: [
      { name: "system", instanceType: "t4g.small", minNodes: 2, maxNodes: 3 },
      {
        name: "workers",
        instanceType: "c6a.large",
        minNodes: 1,
        maxNodes: 10,
        spot: true,
      },
    ],
    tags: { environment: "production", client: "acme" },
    providerOptions: { aws: { autoMode: true } },
  },
  network
) as ICluster;

// 3. DNS — Route 53 hosted zone
const dns = createDns("prod", {
  cloud: "aws",
  zoneName: "example.com",
  records: [
    { name: "app", type: "A", values: ["1.2.3.4"], ttl: 300 },
    { name: "www", type: "CNAME", values: ["app.example.com"], ttl: 300 },
  ],
}) as IDns;

// 4. Secrets — AWS Secrets Manager
const secrets = createSecrets("prod", {
  cloud: "aws",
  backend: "aws-secrets-manager",
  tags: { environment: "production" },
}) as ISecrets;

secrets.putSecret("database", {
  host: "db.internal.example.com",
  password: "change-me-in-pulumi-config",
});

// 5. Platform — Helm components on the cluster
const platform = createPlatformStack("prod", {
  cluster,
  domain: "example.com",
  externalDns: {
    dnsProvider: "route53",
    domainFilters: ["example.com"],
  },
  vault: { enabled: true, ingressHost: "vault.example.com" },
  argocd: { enabled: true },
  headlamp: { enabled: true },
});

const platformStack = Array.isArray(platform) ? platform[0] : platform;
if (!platformStack) throw new Error("No platform stack was created");

// Headlamp is included in exposedServices by default. Enable this optional
// gateway to make platform services available from the Tailscale tailnet.
const config = new pulumi.Config();
if (config.getBoolean("enableTailscaleAccess")) {
  createAccessGateway("prod-access", {
    cluster,
    provider: "tailscale",
    tailscale: {
      oauthClientId: config.require("tailscaleOAuthClientId"),
      oauthClientSecret: config.requireSecret("tailscaleOAuthClientSecret"),
      routes: [],
      services: platformStack.exposedServices,
    },
  });
}

// Stack outputs
export const vpcId = network.vpcId;
export const clusterEndpoint = cluster.endpoint;
export const zoneId = dns.zoneId;
export const nameServers = dns.nameServers;
export const platformName = Array.isArray(platform) ? platform[0]?.name : platform.name;
