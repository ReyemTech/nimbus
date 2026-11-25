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
  clusterNameForTags: "prod",
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

### EKS ExternalDNS community add-on

On AWS EKS with Route 53, Nimbus uses the EKS community add-on and Pod Identity.
Supply hosted zone IDs to scope both IAM permissions and ExternalDNS zone
discovery; domain filters are the fallback and must resolve to unique hosted
zones. Keep any existing TXT owner ID when
migrating from the Helm chart.

```typescript
createPlatformStack("prod", {
  cluster,
  domain: "example.com",
  externalDns: {
    dnsProvider: "route53",
    hostedZoneIds: [dns.zoneId],
    addonVersion: "v1.0.0-eksbuild.1",
    domainFilters: ["example.com"],
    values: {
      txtOwnerId: "prod-cluster",
      sources: ["ingress", "service", "traefik-proxy"],
      registry: "txt",
      policy: "sync",
    },
  },
});
```

Nimbus grants record changes only on the selected hosted zones and does not
create an IAM user, access key, or Kubernetes AWS credential Secret for EKS.
For an existing Helm installation, migrate in two updates: first set
`externalDns.enabled: false` and apply to remove the chart and static
credentials; then enable it again with the prior domain filters and exact same
`txtOwnerId`, and apply to create the add-on. This avoids two controllers
writing the same records during replacement. Non-EKS Route 53 and other DNS
providers continue to use the Helm path.

### AWS cluster cost-allocation tags

Nimbus tags EKS-owned resources with `nimbus:cluster=<region>/<cluster-name>` and
preserves configured AWS resource tags. The generated identifier wins if caller
tags contain the same key. Use the cluster output for AWS resources managed
alongside Nimbus, including the AWS Load Balancer Controller's ALBs, NLBs,
target groups, and controller-created security groups:

```typescript
import * as k8s from "@pulumi/kubernetes";

const awsLoadBalancerControllerValues = {
  clusterName: "prod",
  defaultTags: cluster.awsResourceTags,
};

new k8s.helm.v3.Release("aws-load-balancer-controller", {
  chart: "aws-load-balancer-controller",
  repositoryOpts: { repo: "https://aws.github.io/eks-charts" },
  namespace: "kube-system",
  values: awsLoadBalancerControllerValues,
});
```

For a dedicated Nimbus AWS network, set `clusterNameForTags` to the matching
cluster name in `createNetwork`; this tags the VPC, subnets, gateways, route
tables, NAT resources, and their supported EC2/Auto Scaling children. Leave it
unset for shared networks so Nimbus does not assign exclusive cluster ownership.
The ASG tag propagates to newly launched managed-node instances; it does not
backfill running instances. Backfill those instances with a reviewed AWS tagging
operation. When a managed node group does not already use a launch template,
Nimbus does not create one solely for tagging; its EBS volumes therefore need a
separate tagging operation. AWS resources that do not support user tags,
caller-owned certificates, and infrastructure managed outside Nimbus remain
outside Nimbus's ownership.

Activate `nimbus:cluster` as a user-defined cost allocation tag in Billing and
Cost Management before using it in Cost Explorer. Tag activation is account-wide
and does not retroactively populate historical cost data.

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
    nodePools: [{ name: "workers", instanceType: "t4g.large", minNodes: 2, maxNodes: 5 }],
    providerOptions: {
      aws: {
        endpointAccess: "both",
        publicAccessCidrs: config.requireObject<string[]>("eksPublicAccessCidrs"),
        clusterAdminRoleArn: config.require("eksAdminRoleArn"),
        kubernetesProviderRoleArn: config.require("eksAdminRoleArn"),
        authenticationMode: "API",
        bootstrapClusterCreatorAdminPermissions: false,
        upgradePolicy: { supportType: "STANDARD" },
        nodeGroupAmiType: "AL2023_ARM_64_STANDARD",
        nodeGroupInstanceTags: { Name: "reyemtech-public-arm64" },
        nodeGroupRootDisk: { sizeGiB: 80, deleteOnTermination: true },
        ebsCsiDriver: true,
        communityAddons: {
          prometheusNodeExporter: {},
          kubeStateMetrics: {},
          certManager: {},
        },
        awsAddons: {
          efsCsiDriver: {
            podIdentityRoleArn: config.require("efsCsiRoleArn"),
            // Optional; required only when using EFS CSI with S3 Files.
            nodePodIdentityRoleArn: config.get("efsS3FilesNodeRoleArn"),
          },
          secretsStoreCsiDriverProvider: {},
          cloudWatchObservability: { podIdentityRoleArn: config.require("cloudWatchRoleArn") },
          csiSnapshotController: {},
          guardDutyAgent: {}, // Requires GuardDuty Runtime Monitoring to be enabled.
          nodeMonitoringAgent: {},
          mountpointS3CsiDriver: {
            serviceAccountRoleArn: config.require("s3CsiRoleArn"),
          },
          fsxCsiDriver: { podIdentityRoleArn: config.require("fsxCsiRoleArn") },
        },
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

The community add-on settings are optional. When selected, each supports an
optional `version` and `configurationValues` override. Node Exporter and
kube-state-metrics replace the corresponding kube-prometheus-stack subcharts;
configure Prometheus scraping for those EKS add-on services if required.
cert-manager replaces Nimbus's Helm chart while Nimbus keeps creating its
configured issuers and certificates.

`awsAddons` exposes other opt-in AWS add-ons. EFS CSI, CloudWatch Observability, and
FSx CSI use caller-created Pod Identity roles; Nimbus creates the add-on association
and Pod Identity agent when needed, but does not create IAM roles or attach policies.
S3 Mountpoint CSI uses a caller-created IRSA role via `serviceAccountRoleArn`; scope
its S3 access to the required bucket. The Secrets Store provider has no add-on IAM role,
but workloads need their own identity for secret access. The snapshot and node health
agents need no add-on role. GuardDuty Runtime Monitoring must already be enabled for the
GuardDuty agent to provide runtime detection. EKS Auto Mode already includes the node
monitoring agent, so Nimbus rejects enabling it explicitly.

AWS policy and add-on requirements can change; consult the [EKS add-on catalog](https://docs.aws.amazon.com/eks/latest/userguide/workloads-add-ons-available-eks.html), [S3 Mountpoint IAM setup](https://docs.aws.amazon.com/eks/latest/userguide/s3-csi-create.html), and [GuardDuty EKS Runtime Monitoring](https://docs.aws.amazon.com/guardduty/latest/ug/eksrunmon-deploy-security-agent.html) for the selected add-on and version.

`upgradePolicy: { supportType: "STANDARD" }` avoids extended-support charges,
but AWS automatically upgrades the control plane at the end of standard support.
Choose `EXTENDED` if you need to stay on a version longer and accept the additional
cost; review the [EKS upgrade policy](https://docs.aws.amazon.com/eks/latest/userguide/view-upgrade-policy.html).

EKS Auto Mode already provides block storage and does not use the standard EBS
CSI add-on. Nimbus rejects `ebsCsiDriver`, `nodeGroupRootDisk`, `nodeGroupAmiType`,
and `nodeGroupInstanceTags` when Auto Mode is enabled.

### EKS Metrics Server

Metrics Server is an opt-in EKS community add-on, separate from Prometheus. The
example pins an add-on version and supplies its add-on configuration; omit either
value to use the EKS default behavior.

```typescript
import { createCluster } from "@reyemtech/nimbus";

const cluster = createCluster(
  "prod",
  {
    cloud: "aws",
    nodePools: [{ name: "workers", instanceType: "m7i.large", minNodes: 2, maxNodes: 5 }],
    providerOptions: {
      aws: {
        metricsServer: {
          enabled: true,
          addonVersion: "v0.7.2-eksbuild.1",
          configurationValues: JSON.stringify({ replicas: 2 }),
        },
      },
    },
  },
  network
);
```

After the add-on has started and completed an initial sampling interval, verify
the Kubernetes Metrics API and current CPU/memory readings:

```sh
kubectl get apiservice v1beta1.metrics.k8s.io
kubectl top nodes
kubectl top pods -A
```

`metrics.k8s.io` should be `Available=True`. Metrics Server is EKS-specific and
provides current resource metrics; it does not replace Prometheus for history,
dashboards, or alerting. EKS checks explicitly requested add-on versions against
the cluster Kubernetes version.

### EKS mixed Cluster Autoscaler and Karpenter pools

Use Cluster Autoscaler for steady capacity and a separate Karpenter pool for
bursts. The stable managed pool hosts both controllers; each controller has
distinct IAM permissions and capacity ownership.

```typescript
import { createCluster } from "@reyemtech/nimbus";

const cluster = createCluster(
  "prod",
  {
    cloud: "aws",
    nodePools: [
      {
        name: "steady",
        instanceType: "m7i.large",
        minNodes: 3,
        maxNodes: 10,
        scaling: { mode: "cluster-autoscaler" },
        labels: { "capacity.nimbus.dev/class": "steady" },
      },
      {
        name: "batch-burst",
        labels: { "capacity.nimbus.dev/class": "burst" },
        taints: [{ key: "workload", value: "batch", effect: "NoSchedule" }],
        scaling: {
          mode: "karpenter",
          instanceTypes: ["m7i.large", "m7i.xlarge", "m7a.large"],
          capacityTypes: ["spot", "on-demand"],
          availabilityZones: ["ca-central-1a", "ca-central-1b"],
          limits: { cpu: "200", memory: "800Gi" },
        },
      },
    ],
    providerOptions: {
      aws: {
        clusterAutoscaler: {},
        karpenter: { interruptionHandling: true },
        autoscalerControllerNodePoolName: "steady",
      },
    },
  },
  network
);
```

An application that should use only burst capacity must select the burst label
and tolerate its taint. The steady group remains independently scalable by
Cluster Autoscaler; Karpenter does not own or modify its Auto Scaling group.

```yaml
spec:
  template:
    spec:
      nodeSelector:
        capacity.nimbus.dev/class: burst
      tolerations:
        - key: workload
          operator: Equal
          value: batch
          effect: NoSchedule
```

Nimbus creates EKS Pod Identity roles and policies for the controllers, the
Pod Identity Agent add-on, Karpenter's separate node role and access entry, and
Karpenter's CRDs/controller. Karpenter IAM has no Auto Scaling group mutation
actions, and its `iam:PassRole` permission targets only its worker role.
Cluster Autoscaler can change only ASGs Nimbus tags for that scaler. These
controls prevent either scaler from taking ownership of the other's pool.

The Pulumi deployment identity must be allowed to create the selected EKS
add-on, IAM roles and inline policies, Pod Identity associations, EKS access
entries, and the related Auto Scaling tags. Karpenter Spot interruption
handling also creates an SQS queue, queue policy, EventBridge rules, and event
targets. At runtime, Cluster Autoscaler receives describe permissions plus
`SetDesiredCapacity` and `TerminateInstanceInAutoScalingGroup` conditioned on
the selected group's discovery tag. Karpenter receives EC2 provisioning and
instance-profile permissions, `iam:PassRole` only for its own worker role, and
SQS receive/delete permissions only for its interruption queue. Keep the
Karpenter node role separate from the controller role.

Controllers are placed on `autoscalerControllerNodePoolName`; keep that pool
steady, on-demand, and large enough to host system services. Karpenter Spot pools
create an SQS interruption queue and EventBridge rules unless disabled. The
queue, Spot interruptions, and Karpenter consolidation can increase churn; set
resource limits and use disruption budgets for critical workloads. Cluster
Autoscaler changes managed-group size in whole-node increments, while
Karpenter can choose among the configured instance types and zones.

To migrate existing managed capacity to Karpenter, add a new Karpenter pool,
move workloads with labels/affinity and taints/tolerations, verify availability,
then remove the old managed group. Do not change a live pool's resource kind in
one update because Pulumi may replace the managed group and its capacity.

See the [Cluster Autoscaler AWS guide](https://github.com/kubernetes/autoscaler/blob/master/cluster-autoscaler/cloudprovider/aws/README.md),
[Karpenter EKS guide](https://karpenter.sh/docs/getting-started/getting-started-with-karpenter/),
and [Karpenter Kubernetes compatibility matrix](https://karpenter.sh/docs/upgrading/compatibility/)
for version, IAM, and compatibility details.

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
through this single NLB. A CloudFront Function derives the trusted `X-Reyem-Client-Host` header
from viewer `Host`, so client-supplied values cannot override it. Keep dynamic and authenticated
routes uncached unless the cache key and origin request policy include every request value that
changes the response. The NLB and
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
