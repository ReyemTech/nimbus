## Single Cloud (AWS)

```typescript
import * as pulumi from "@pulumi/pulumi";
import {
  createAccessGateway,
  createNetwork,
  createCluster,
  createDns,
  createPlatformStack,
} from "@reyemtech/nimbus";
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

// Platform stack (Headlamp stays private; its service is returned for Tailscale)
const platform = createPlatformStack("prod", {
  cluster,
  domain: "example.com",
  externalDns: { dnsProvider: "route53", domainFilters: ["example.com"] },
  vault: { enabled: true, ingressHost: "vault.example.com" },
  argocd: { enabled: true },
  headlamp: { enabled: true },
});

const platformStack = Array.isArray(platform) ? platform[0] : platform;
if (!platformStack) throw new Error("No platform stack was created");

// The Headlamp service is included by default in platformStack.exposedServices.
const config = new pulumi.Config();
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
```

Full example: [`examples/single-cloud-aws/`](../../examples/single-cloud-aws/)

Headlamp uses its managed ServiceAccount by default, bound to a Nimbus ClusterRole
that can read all API resources, so it opens without a pasted token. It can list
PVs, StorageClasses, VolumeAttributesClasses, Gateway API resources and policies,
Roles, RoleBindings, Secrets, PriorityClasses, RuntimeClasses, Leases, webhook
configurations, DeviceClasses, LeaderWorkerSets, and custom resources. Every
viewer shares that identity. Keep it behind the configured, access-controlled
Tailscale gateway or another trusted authentication proxy. Do not expose the
service publicly without an authentication layer. To require individual
Kubernetes credentials instead, set
`headlamp: { enabled: true, authentication: "user-token" }`.
For CPU and memory usage, also enable the EKS `metricsServer` add-on on the
cluster; the Headlamp role has Metrics API access, but it cannot supply metrics
when the API is not installed. See [EKS Metrics Server](#eks-metrics-server).
To access it directly for local troubleshooting, run:

```bash
kubectl port-forward -n headlamp svc/headlamp 8080:80
```

Set `serviceAccountClusterRoleName` to bind Headlamp's ServiceAccount to a
different existing ClusterRole. In `user-token` mode, Headlamp uses Kubernetes'
built-in `view` role by default.

### EKS ExternalDNS community add-on

On AWS EKS with Route 53, Nimbus uses the EKS community add-on and Pod Identity.
Set `domainFilters` to constrain ExternalDNS to the intended DNS suffix, and
provide `hostedZoneIds` to limit record-change permissions to exact zones. The
EKS add-on schema does not accept ExternalDNS's zone-ID filter, so Nimbus grants
`ListResourceRecordSets` read access across zones for discovery while keeping
`ChangeResourceRecordSets` scoped to the configured IDs. Domain filters cannot
distinguish public and private zones with the same name; writes remain blocked
outside the configured IDs, but such duplicate zones can produce access-denied
reconciliation errors. Keep any existing TXT owner ID when migrating from the
Helm chart.

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
