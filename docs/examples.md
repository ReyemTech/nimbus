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

### EKS with restricted access, encrypted node disks, and EBS CSI

Use these options with standard EKS managed node groups. When omitted, Nimbus
keeps the existing endpoint CIDRs, node group disk behavior, and add-on list.

```typescript
import * as pulumi from "@pulumi/pulumi";
import { createCluster } from "@reyemtech/nimbus";

const config = new pulumi.Config();
const cluster = createCluster(
  "prod",
  {
    cloud: "aws",
    nodePools: [{ name: "workers", instanceType: "m7i.large", minNodes: 2, maxNodes: 5 }],
    providerOptions: {
      aws: {
        endpointAccess: "both",
        publicAccessCidrs: config.requireObject<string[]>("eksPublicAccessCidrs"),
        clusterAdminRoleArn: config.require("eksAdminRoleArn"),
        nodeGroupRootDisk: { sizeGiB: 80, deleteOnTermination: true },
        ebsCsiDriver: true,
      },
    },
  },
  network
);
```

`ebsCsiDriver` installs the `aws-ebs-csi-driver` EKS add-on, the Pod Identity
agent, and a dedicated role with `AmazonEBSCSIDriverPolicyV2`. The add-on
creates the IAM association for `ebs-csi-controller-sa`. Create a Kubernetes
StorageClass with `provisioner: ebs.csi.aws.com` and `parameters.type: gp3` for
gp3 PVCs; Nimbus does not change your cluster's default StorageClass.

EKS Auto Mode already provides block storage and does not use the standard EBS
CSI add-on. Nimbus rejects `ebsCsiDriver` and `nodeGroupRootDisk` when Auto Mode
is enabled.

### Shared private Traefik ALB for multiple app hostnames

Use one internal ALB from the existing EKS Traefik ingress. The example reads its ARN and
security-group IDs from the platform stack; Nimbus creates a single CloudFront VPC Origin and
routes all aliases through Traefik using the viewer `Host` header.

```typescript
import * as pulumi from "@pulumi/pulumi";
import { createCdn } from "@reyemtech/nimbus";

const config = new pulumi.Config();
const platform = new pulumi.StackReference(config.require("platformStack"));
const disabledCachePolicy = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";

const cdn = createCdn("prod-apps", {
  cloud: "aws",
  hostedZoneId: config.require("hostedZoneId"),
  originSecretHeader: "X-Reyem-Origin-Secret",
  originSecretValue: config.requireSecret("originSecret"),
  vpcOrigin: {
    type: "alb-vpc",
    albArn: platform.requireOutput("traefikAlbArn"),
    albSecurityGroupIds: [platform.requireOutput("traefikAlbSecurityGroupId")],
    originProtocolPolicy: "http-only",
    httpPort: 80,
    securityGroupPort: 80,
  },
  distributions: [
    {
      hostname: "app1.example.com",
      aliases: ["app2.example.com"],
      certificateArn: config.require("cloudFrontCertificateArn"),
      cachePolicyId: disabledCachePolicy,
      allowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
      cachedMethods: ["GET", "HEAD"],
      viewerProtocolPolicy: "redirect-to-https",
      orderedCacheBehaviors: [
        {
          pathPattern: "/api/*",
          cachePolicyId: disabledCachePolicy,
          allowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
          cachedMethods: ["GET", "HEAD"],
          viewerProtocolPolicy: "https-only",
        },
      ],
    },
  ],
});
```

The default and `/api/*` behavior are uncached for dynamic and authenticated app traffic. Add a
cache policy to a static path only when its responses are public and the cache key varies on
every request value that changes the response. For shared hostnames, that may include `Host`.
The ACM certificate must cover both aliases. Nimbus owns the CloudFront VPC Origin, ingress
rules, distributions, and DNS aliases; the platform stack keeps ownership of the ALB and
Traefik resources. The ALB must be internal, its subnets must be private and have free IPv4
space, its VPC must have an internet gateway attached, and its region/AZs must be supported by
AWS for VPC Origins. See the [AWS VPC Origins prerequisites](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html#private-content-vpc-origins-prerequisites).

For HTTPS-only or match-viewer CloudFront-to-ALB traffic, the ALB's trusted certificate must
cover the forwarded viewer `Host` aliases. The aliases in this example must also be in the
configured Route 53 hosted zone.

The deploy identity needs CloudFront VPC Origin/distribution permissions, read access to the
ALB and VPC metadata, permission to add/remove ingress rules on the selected ALB security
groups, and permission to manage the Route 53 aliases. AWS may require permission to create
its `AWSServiceRoleForCloudFrontVPCOrigin` service-linked role on first use. Nimbus leaves
other ALB security-group rules intact.

### Shared private Traefik NLB with HTTP VPC Origin

The AWS Load Balancer Controller can provision one internal IPv4 NLB from Traefik's
`LoadBalancer` Service. Apply the Service once for the shared Traefik ingress, then export the
active NLB ARN and attached security-group ID from the platform stack for Nimbus. The explicit
frontend security group lets Nimbus restrict NLB ingress to CloudFront's service-managed VPC
Origin security group; the controller manages the backend target rules.

```yaml
apiVersion: v1
kind: Service
metadata:
  name: traefik
  namespace: traefik
  annotations:
    service.beta.kubernetes.io/aws-load-balancer-name: traefik-shared
    service.beta.kubernetes.io/aws-load-balancer-scheme: internal
    service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
    service.beta.kubernetes.io/aws-load-balancer-security-groups: sg-traefik-nlb
    service.beta.kubernetes.io/aws-load-balancer-manage-backend-security-group-rules: "true"
spec:
  loadBalancerClass: service.k8s.aws/nlb
  type: LoadBalancer
  selector:
    app.kubernetes.io/name: traefik
  ports:
    - name: web
      port: 80
      targetPort: web
      protocol: TCP
```

Create or select `sg-traefik-nlb` in the NLB VPC before applying the Service, with no broader
ingress rules than you intend to allow. Nimbus adds the CloudFront rule and leaves existing
ingress intact. With the `aws-load-balancer-security-groups` annotation, the controller does
not manage the NLB's frontend ingress rules. The controller still manages target security-group
rules because the example enables `aws-load-balancer-manage-backend-security-group-rules`. See
the [AWS Load Balancer Controller
NLB annotations](https://kubernetes-sigs.github.io/aws-load-balancer-controller/latest/guide/service/annotations/).

After the controller reports the NLB active, export its ARN and security-group ID from the
platform stack. In the Nimbus stack, reference those outputs:

```typescript
import * as pulumi from "@pulumi/pulumi";
import { createCdn } from "@reyemtech/nimbus";

const config = new pulumi.Config();
const platform = new pulumi.StackReference(config.require("platformStack"));
const disabledCachePolicy = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";

createCdn("prod-apps", {
  cloud: "aws",
  hostedZoneId: config.require("hostedZoneId"),
  originSecretHeader: "X-Reyem-Origin-Secret",
  originSecretValue: config.requireSecret("originSecret"),
  vpcOrigin: {
    type: "nlb-vpc",
    nlbArn: platform.requireOutput("traefikNlbArn"),
    nlbSecurityGroupIds: [platform.requireOutput("traefikNlbSecurityGroupId")],
    originProtocolPolicy: "http-only",
    httpPort: 80,
  },
  distributions: [
    {
      hostname: "app1.example.com",
      aliases: ["app2.example.com"],
      certificateArn: config.require("cloudFrontCertificateArn"),
      cachePolicyId: disabledCachePolicy,
      allowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
      cachedMethods: ["GET", "HEAD"],
      viewerProtocolPolicy: "redirect-to-https",
    },
  ],
});
```

Viewers use HTTPS to CloudFront; CloudFront sends HTTP on port 80 through the TCP NLB listener
to Traefik's HTTP Service. Nimbus forwards viewer `Host`, so Traefik routes both app aliases
through this single NLB. Keep dynamic and authenticated routes uncached unless the cache key
and origin request policy include every request value that changes the response. The NLB and
Traefik Service stay owned by the platform stack; Nimbus owns the CloudFront VPC Origin and its
ingress rule. NLB VPC Origins require an internal IPv4 NLB with an attached security group, no
TLS listener, and supported private subnets/region/AZs. See the [AWS VPC Origins
prerequisites](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-vpc-origins.html#private-content-vpc-origins-prerequisites).

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
