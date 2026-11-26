# AWS provider guide

Nimbus provisions AWS infrastructure through Pulumi AWS, AWSX, EKS, and Kubernetes providers. This guide covers EKS configuration, managed node groups, add-ons, autoscaling, resource tagging, VPC networking, and CloudFront private origins.

## EKS and AWS provider options

### AWS EKS options

`createEksCluster(..., options?)` accepts these AWS-specific options directly.
The same options are available under `createCluster(..., { providerOptions: {
aws: ... }})`.

| Option                                                           | Description                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publicAccessCidrs`                                              | CIDRs allowed to reach the public API endpoint. Applies when public endpoint access is enabled.                                                                                                                                                                                                                                                                                          |
| `clusterAdminRoleArn`                                            | IAM principal ARN (role or user) granted `AmazonEKSClusterAdminPolicy` through an EKS access entry.                                                                                                                                                                                                                                                                                      |
| `kubernetesProviderRoleArn`                                      | Optional IAM role assumed by the Kubernetes provider's `aws eks get-token` command. Use it when the provider must authenticate as a role different from the deployment credentials; that role must have EKS access.                                                                                                                                                                      |
| `nodeGroupRootDisk`                                              | Enables an encrypted gp3 root disk launch template for managed node groups. `sizeGiB` defaults to 20 and `deleteOnTermination` defaults to `true`. Omit the option to preserve EKS defaults.                                                                                                                                                                                             |
| `nodeGroupAmiType`                                               | AMI family for managed node groups, such as `AL2023_ARM_64_STANDARD`.                                                                                                                                                                                                                                                                                                                    |
| `nodeGroupInstanceTags`                                          | EC2 instance tags propagated through managed node-group launch-template `tagSpecifications`.                                                                                                                                                                                                                                                                                             |
| `ebsCsiDriver`                                                   | Installs the EBS CSI add-on and Pod Identity agent, with a dedicated role attached to `AmazonEBSCSIDriverPolicyV2`. Defaults to `false`.                                                                                                                                                                                                                                                 |
| `metricsServer`                                                  | Opt-in EKS community add-on providing the Kubernetes Resource Metrics API. Set `true` to use the EKS-compatible default, or pass `{ enabled?, addonVersion?, configurationValues? }`. EKS validates version compatibility. This is separate from Prometheus and is EKS-only.                                                                                                             |
| `communityAddons`                                                | Opts into typed EKS community add-ons for Prometheus Node Exporter, kube-state-metrics, and cert-manager. Each accepts optional `version` and `configurationValues`.                                                                                                                                                                                                                     |
| `clusterAutoscaler`                                              | Install one Cluster Autoscaler controller when at least one managed pool uses `scaling: { mode: "cluster-autoscaler" }`. Optional `version` selects the Helm chart version; Nimbus chooses a pinned chart compatible with the cluster version when omitted. Nimbus uses IRSA for the controller; it creates the cluster OIDC provider unless `oidcProviderArn` supplies an existing one. |
| `karpenter`                                                      | Install one Karpenter controller when a pool uses `scaling: { mode: "karpenter", ... }`. Optional `version`, `namespace`, and `interruptionHandling` configure the shared controller. Spot interruption handling defaults on for Spot pools.                                                                                                                                             |
| `autoscalerControllerNodePoolName`                               | Required when either scaler is selected. Names a managed pool with `minNodes >= 1`; Nimbus pins controller pods to this steady pool.                                                                                                                                                                                                                                                     |
| `awsAddons`                                                      | Typed opt-in AWS add-ons: EFS CSI, Secrets Store CSI provider, CloudWatch Observability, CSI snapshot controller, GuardDuty agent, Node Monitoring agent, S3 Mountpoint CSI, and FSx CSI. Each accepts version/configuration overrides; add-ons needing AWS access require a caller-provided role ARN.                                                                                   |
| `authenticationMode` / `bootstrapClusterCreatorAdminPermissions` | EKS access configuration. Defaults preserve Nimbus's existing `API_AND_CONFIG_MAP` mode and AWS's creator-admin behavior. When creator admin is disabled, use API authentication and provide `clusterAdminRoleArn` so Nimbus can grant access before Kubernetes resources run.                                                                                                           |
| `upgradePolicy`                                                  | Sets `supportType` to `STANDARD` or `EXTENDED`. Omitted preserves AWS's current `EXTENDED` default. `STANDARD` avoids extended-support charges but AWS automatically upgrades the control plane at end of standard support; `EXTENDED` keeps the version longer at additional cost. See [AWS upgrade policy](https://docs.aws.amazon.com/eks/latest/userguide/view-upgrade-policy.html). |

On AWS networks, `privateSubnetIds` resolves after route-table associations and the NAT default route report `active`. The fck-nat Auto Scaling Group waits up to 15 minutes for one healthy in-service instance before creating the private default route. If the route remains `blackhole`, the network output fails and dependent node groups are not created. Use `natStrategy: "managed"` for AWS-managed NAT gateways.

The EBS CSI option is not supported with EKS Auto Mode, which has built-in block
storage. Nimbus does not create or change a StorageClass; create one with
`provisioner: ebs.csi.aws.com` and `parameters.type: gp3` to provision gp3 PVCs.

Selecting `communityAddons.prometheusNodeExporter` or `communityAddons.kubeStateMetrics`
disables the matching kube-prometheus-stack subchart on that cluster to avoid duplicate
agents. Configure Prometheus scraping for the community add-on services as needed.
Selecting `communityAddons.certManager` replaces the platform stack's cert-manager Helm
release; Nimbus continues creating its configured issuers and certificates.

`awsAddons` keeps these add-ons opt-in. EFS CSI, CloudWatch Observability, and FSx CSI
use `podIdentityRoleArn`; Nimbus installs the Pod Identity agent when needed and creates
the association, but the caller creates the role and attaches required permissions.
S3 Mountpoint CSI requires `serviceAccountRoleArn` for a caller-created IRSA role scoped
to the target bucket. The Secrets Store CSI provider itself needs no IAM role; application
pods need their own identity. The snapshot controller and Node Monitoring agent need no
add-on role. EKS Auto Mode already includes Node Monitoring, so Nimbus rejects selecting
it explicitly there.

Nimbus creates Pod Identity associations, not IAM roles or policies. Pod Identity roles
must trust `pods.eks.amazonaws.com` for `sts:AssumeRole` and `sts:TagSession`; restrict
the trust with EKS request-tag conditions for the intended namespace and service account.
The Pulumi deployment principal also needs `iam:PassRole` for each supplied role. See
[AWS Pod Identity role trust guidance](https://docs.aws.amazon.com/eks/latest/userguide/pod-id-role.html).

| Add-on                                                         | Role permissions to attach                                                                                                                                                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| EFS CSI controller (`efsCsiDriver.podIdentityRoleArn`)         | EFS only: `AmazonEFSCSIDriverPolicy`. S3 Files: `AmazonS3FilesCSIDriverPolicy`; both backends: both policies.                                                                                                                                                            |
| EFS CSI node (`efsCsiDriver.nodePodIdentityRoleArn`, optional) | Required for S3 Files: `AmazonS3FilesClientFullAccess`, `AmazonS3ReadOnlyAccess`, and `AmazonElasticFileSystemsUtils`.                                                                                                                                                   |
| CloudWatch Observability                                       | `CloudWatchAgentServerPolicy` and `AWSXrayWriteOnlyAccess`.                                                                                                                                                                                                              |
| FSx CSI                                                        | AWS documents `AmazonFSxFullAccess` as required; it is broad, so review the policy and scope it to your environment where possible.                                                                                                                                      |
| S3 Mountpoint CSI                                              | Create a bucket-scoped policy: `s3:ListBucket` on the bucket ARN and `s3:GetObject`, `s3:PutObject`, `s3:AbortMultipartUpload`, and `s3:DeleteObject` on its object ARNs. Remove write actions for read-only workloads. The cluster needs an IAM OIDC provider for IRSA. |
| Secrets Store CSI provider                                     | No add-on role. Grant each workload only the required Secrets Manager and/or SSM Parameter Store read actions and resource ARNs; add `kms:Decrypt` for customer-managed keys when needed.                                                                                |

The EFS node role is only needed for S3 Files. AWS's current guidance and policy details
are in the [EKS add-on IAM reference](https://docs.aws.amazon.com/eks/latest/userguide/workloads-add-ons-available-eks.html),
[S3 Files CSI setup](https://docs.aws.amazon.com/eks/latest/userguide/s3files-csi.html), and
[Mountpoint CSI setup](https://docs.aws.amazon.com/eks/latest/userguide/s3-csi-create.html).

GuardDuty Runtime Monitoring must be enabled for the GuardDuty agent to provide runtime
detection. Use that option only when Nimbus should own the EKS add-on lifecycle.
CloudWatch Observability enables AWS metrics and log collection by default; review its
collection settings if Nimbus Alloy also ships logs.

```typescript
createCluster(
  "prod",
  {
    cloud: "aws",
    nodePools: [{ name: "workers", instanceType: "m7i.large", minNodes: 2, maxNodes: 5 }],
    providerOptions: {
      aws: {
        publicAccessCidrs: ["203.0.113.0/24"],
        clusterAdminRoleArn: adminRole.arn,
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

Enable Metrics Server independently of Prometheus when `kubectl top` or
resource-metrics consumers need recent CPU and memory readings:

```typescript
createCluster(
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

Omit `addonVersion` to let EKS select its compatible default. After deployment,
allow Metrics Server an initial sampling interval, then check the API and query
current usage:

```sh
kubectl get apiservice v1beta1.metrics.k8s.io
kubectl top nodes
kubectl top pods -A
```

The APIService should report `Available=True`. Metrics Server serves short-lived
resource metrics for commands such as `kubectl top` and resource-based autoscaling;
Prometheus remains the separate system for historical monitoring and alerting.

EKS node pools also support explicit capacity ownership. Existing pool objects
without `scaling` keep their current EKS managed-node-group behavior. Use
`{ mode: "fixed" }` to pin a managed pool to `desiredNodes ?? minNodes`,
`{ mode: "cluster-autoscaler" }` for a managed group Cluster Autoscaler may
adjust, or `mode: "karpenter"` for a Karpenter NodePool with instance types,
capacity types, optional AZs, and CPU/memory limits. See the mixed example in
[EKS mixed autoscaling](../examples/aws.md#eks-mixed-cluster-autoscaler-and-karpenter-pools).
For a zero-node fixed pool, Nimbus sets desired and minimum size to zero and
maximum size to one because the EKS API requires `maxSize >= 1`.

Nimbus creates one controller and IAM role per selected scaler. Cluster
Autoscaler uses IRSA to support the AWS SDK version in its pinned image;
Karpenter uses Pod Identity, and Nimbus attaches the Pod Identity Agent when
needed. Cluster Autoscaler gets discovery tags and scale permissions only for selected managed groups;
Karpenter receives a separate worker role and provisions only its own NodePools
in Nimbus private subnets using the EKS cluster security group. A stable managed
pool is required for controller placement. Keep the stable pool's minimum at
one or more nodes so the controllers can start before burst capacity exists.

For a complete Pulumi config example, see [EKS with restricted access, encrypted node disks, and EBS CSI](../examples/aws.md#eks-with-restricted-access-encrypted-node-disks-and-ebs-csi).

### CloudFront VPC Origins

`createCdn` can create one shared CloudFront VPC Origin from an existing private ALB or NLB ARN.
Nimbus validates the load balancer and VPC Origin prerequisites, then adds ingress from AWS's
service-managed CloudFront VPC Origins security group.

| Option                                                      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vpcOrigin`                                                 | Optional shared private origin. `type: "alb-vpc"` accepts `albArn`, `originProtocolPolicy`, `httpPort`, `httpsPort`, `securityGroupPort`, and `albSecurityGroupIds`. `type: "nlb-vpc"` accepts `nlbArn`, HTTP-only `originProtocolPolicy`, `httpPort` (default 80), `securityGroupPort`, and `nlbSecurityGroupIds`; NLBs must be IPv4 and have no TLS listeners. With one attached security group, Nimbus infers it; otherwise select attached groups explicitly. Private origins also derive the trusted client-host header from viewer `Host` with a CloudFront Function. |
| `aliases`                                                   | Additional hostnames on a distribution; all are routed through the shared ALB or NLB and need coverage in the viewer ACM certificate. Keep aliases in the configured Route 53 hosted zone.                                                                                                                                                                                                                                                                                                                                                                                  |
| `cachePolicyId` / `originRequestPolicyId`                   | Default behavior policy IDs, overridable per ordered path behavior. Private origins default to CachingDisabled and a Host-forwarding policy.                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `allowedMethods` / `cachedMethods` / `viewerProtocolPolicy` | Distribution behavior settings, overridable per ordered path behavior. Cached methods must be included in allowed methods.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

```typescript
createCdn("prod-apps", {
  cloud: "aws",
  hostedZoneId,
  originSecretHeader: "X-Reyem-Origin-Secret",
  originSecretValue,
  vpcOrigin: {
    type: "alb-vpc",
    albArn: traefikAlb.arn,
    albSecurityGroupIds: [traefikAlbSecurityGroup.id],
    originProtocolPolicy: "http-only",
    httpPort: 80,
  },
  distributions: [
    {
      hostname: "app1.example.com",
      aliases: ["app2.example.com"],
      certificateArn,
      cachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
      orderedCacheBehaviors: [
        { pathPattern: "/api/*", cachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad" },
      ],
    },
  ],
});
```

Dynamic, authenticated, and personalized routes should remain uncached unless their cache key
and origin request policy include every response-varying request value. Public custom origins
keep their previous defaults. If CloudFront uses HTTPS to reach the ALB, its certificate must
cover the forwarded viewer `Host` alias. NLB VPC Origins require HTTP-only because CloudFront
rejects NLB TLS listeners. See [Shared private Traefik ALB for multiple app hostnames](../examples/aws.md#shared-private-traefik-alb-for-multiple-app-hostnames) and [Shared private Traefik NLB with HTTP VPC Origin](../examples/aws.md#shared-private-traefik-nlb-with-http-vpc-origin) for full examples and ownership/prerequisite details.

For maximum control, use cloud-specific functions directly via subpath imports:

```typescript
import { createAwsNetwork, createEksCluster } from "@reyemtech/nimbus/aws";
import { createAzureNetwork, createAksCluster } from "@reyemtech/nimbus/azure";
```

Available functions:

- `createAwsNetwork(name, config, options?)` / `createAzureNetwork(name, config, options)`
- `createEksCluster(name, config, network, options?)` / `createAksCluster(name, config, network, options)`
- `createRoute53Dns(name, config)` / `createAzureDns(name, config, options)`
- `createAwsSecrets(name, config)` / `createAzureSecrets(name, config, options)`
- `createAwsStateBackend(name, config, options?)` / `createAzureStateBackend(name, config, options)`

### Private Route 53 zones and Ingress DNS visibility

Private DNS is opt-in and applies to AWS EKS with Route 53. Without
`externalDns.route53.privateHostedZones`, Nimbus keeps the existing EKS
ExternalDNS community add-on and its current behavior. When private zones are
configured, Nimbus creates separate ExternalDNS controllers for public
Ingresses, private Ingresses, and public Service/Traefik records. Each
controller has its own Pod Identity role, service account, controller ID, and
TXT owner ID. IAM record-change permissions are limited to the zone IDs assigned
to that controller.

Configure created zones with a selectable one-label prefix. If omitted, the
private zone is `internal.<platform-domain>`; for multiple clusters, use a
unique prefix such as `cac-1` to produce `cac-1.reyem.tech`:

```typescript
createPlatformStack("prod", {
  cluster,
  domain: "reyem.tech",
  externalDns: {
    dnsProvider: "route53",
    hostedZoneIds: [publicZoneId],
    domainFilters: ["reyem.tech"],
    values: {
      txtOwnerId: "prod-public",
      registry: "txt",
      policy: "upsert-only",
    },
    route53: {
      privateHostedZones: [{ mode: "create", prefix: "cac-1" }],
      privateTxtOwnerId: "prod-cac-1-private",
      privatePolicy: "upsert-only",
    },
  },
});
```

For a pre-existing private zone, provide its ID and exact domain filter. Nimbus
does not own or delete that zone. `associateClusterVpc` defaults to `false`; set
it only when Nimbus should create and own the VPC association. The VPC must be
associated for cluster workloads to resolve the private zone. Cross-account
association authorization must be completed outside Nimbus before association.

```typescript
route53: {
  privateHostedZones: [{
    mode: "existing",
    hostedZoneId: config.require("privateHostedZoneId"),
    domainFilter: "cac-1.reyem.tech",
    associateClusterVpc: false,
  }],
}
```

Ingress visibility uses `nimbus.dev/dns-visibility: public|private`. An absent
annotation remains public for backwards compatibility. DNS visibility is
independent of ingress class, load-balancer scheme, and TLS; configure an
internal load balancer separately for private services. The private controller
only watches explicitly private Ingresses and only targets configured private
zones. Public Ingresses are excluded from private zones, and private Ingresses
are excluded from public zones. Service and Traefik CRD sources remain on the
public controller. An alternate annotation key can be selected with
`ingressVisibilityAnnotation`.

In split mode, record policy defaults to `upsert-only`, so changing an Ingress
from public to private creates/updates the private record without deleting the
existing public record. Migrate by applying the private annotation, checking
that the private record and TXT ownership are correct, then explicitly remove
the old public record if desired. Set `values.policy: "sync"` to opt into
ExternalDNS deletion behavior; this is a destructive policy and should only be
used when the configured source and zone filters represent the full desired
record set. The split controllers and hosted-zone resources appear in Pulumi
preview. Nimbus does not replace an existing public zone or load balancer.

`mode: "create"` zones and explicitly requested VPC associations are Nimbus
owned. Existing zones are caller owned. Nimbus does not enable force deletion;
Route 53 may refuse to delete a created zone while records (including
ExternalDNS TXT ownership records) remain. Before disabling the private feature,
remove or migrate managed records and inspect the preview. Disabling removes
only resources owned by this configuration.

Choose the prefix before publishing records where possible. Changing a created
zone from `internal` to `cac-1` creates a different hosted zone. For a safe
migration, temporarily configure both zone entries, update Ingress hostnames and
Tailnet forwarding to the new suffix, verify resolution, remove old records, and
then remove the old zone entry in a later Pulumi update.

For Tailnet split DNS, align the Tailnet/CoreDNS forwarded suffix with the
selected private zone: `cac-1.reyem.tech` for `prefix: "cac-1"`, or
`internal.reyem.tech` when omitted. Configure the existing access gateway's
DNS suffix and forwarding rules to match; Nimbus does not modify Tailnet DNS
automatically. This allows separate cluster prefixes to coexist without
colliding. DNS-01 certificate validation is independent of service-record
visibility: for a publicly registered domain, cert-manager can publish ACME
challenge records in the public authoritative zone while the application record
is private. A private-only domain cannot be validated by a public ACME authority.

See [AWS private DNS example](../examples/aws.md#private-route-53-and-ingress-visibility)
for complete public/private Ingress and stack configuration.

## AWS examples

See [AWS examples](../examples/aws.md) for ExternalDNS, cluster tagging, private API access, encrypted gp3 nodes, Metrics Server, autoscaler separation, and shared Traefik CloudFront origins.

## Cost and operational notes

- EKS `STANDARD` support can automatically upgrade the control plane at standard-support end; `EXTENDED` costs more.
- Managed NAT gateways simplify egress; fck-nat can reduce cost but depends on healthy EC2 capacity before private routes become active.
- Cluster Autoscaler and Karpenter must own separate pools. Keep controller pods on a stable managed pool.
- Nimbus resource tags flow to supported AWS-created children; controller-created resources may need Kubernetes/AWS Load Balancer Controller tag configuration.

## More AWS documentation

- [Shared API reference](../api-reference.md)
- [Kubernetes access](../guides/kubernetes-access.md)
- [Architecture](../architecture/component-diagram.md)
