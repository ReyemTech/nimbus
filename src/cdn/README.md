# CDN

`createCdn` provisions the trusted CloudFront edge used by applications that opt into the
edge-trust middleware. Each distribution has one primary `hostname` and may have additional
CloudFront `aliases`. Public custom origins keep the existing static client-host header. Private
VPC origins forward the viewer `Host`, allowing one Traefik ALB or NLB to route aliases by hostname.
Nimbus also associates a viewer-request CloudFront Function that overwrites the trusted client-host
header from the viewer `Host`, preserving the edge-trust boundary for private origins.

Public custom origins use an origin request policy that excludes `Host`, forward CloudFront
viewer-address and geo headers, and add the configured static client-host header. Private VPC
origins forward the viewer `Host` so Traefik can route aliases. Every origin request includes
the configured origin secret. `hostedZoneId` creates both Route 53 `A` and `AAAA` aliases for
every distribution; the cluster-managed origin DNS remains out of scope.

## Private EKS ALB through CloudFront VPC Origins

Set `vpcOrigin` on the CDN config with the ARN of an existing internal Application Load
Balancer. Nimbus creates one CloudFront VPC Origin shared by all configured distributions,
looks up the ALB's region, subnets, and security groups, validates the VPC Origin prerequisites,
and allows the AWS-managed `CloudFront-VPCOrigins-Service-SG` into the selected ALB security
group(s). The ALB, listener, target groups, and Traefik routing remain owned by the caller.

Use `aliases` to attach several app hostnames to a distribution that targets the same Traefik
ALB. Private-origin requests forward the viewer `Host` header so Traefik can select the app.
The ACM certificate must cover the primary hostname and every alias. The `originSecretHeader`
continues to be added to requests; Traefik can use it to reject requests that bypass the edge.

Private origins default to the AWS managed CachingDisabled cache policy. Dynamic, session,
authorization-dependent, or personalized routes should stay uncached unless the cache key and
origin request policy account for every request value that changes the response. If you set a
custom `originRequestPolicyId` for a private origin, it must forward viewer `Host` for Traefik
routing and the derived `clientHostHeader` for edge-trust verification.
For HTTPS-only or match-viewer origins, the ALB's trusted TLS certificate must cover each
forwarded host alias.
You can override cache policy, origin request policy, allowed methods, cached methods, and
viewer protocol policy on the distribution or individual ordered behaviors. Ordered behavior
values override distribution values. Public custom origins retain their previous optimized
cache policy, trusted-edge origin request policy, and redirect-to-HTTPS defaults.

The ALB must be internal and use private subnets with available IPv4 addresses. Its region must
support CloudFront VPC Origins, and its subnets cannot be in AWS's excluded AZs. Nimbus adds
ingress to a single attached ALB security group automatically; if the ALB has multiple security
groups, set `albSecurityGroupIds` to the attached group(s) Nimbus should update.

The Pulumi stack managing Nimbus owns the VPC Origin, ALB ingress rule(s), CloudFront
distributions, and Route 53 aliases. The stack that created the EKS ALB continues to own the
ALB and its listeners/security groups; Nimbus does not delete or replace them.

The deploying identity needs permission to manage CloudFront VPC Origins, CloudFront Functions,
and distributions; read the load balancer and VPC subnet, route table, internet gateway, and
security-group metadata; add and remove security-group ingress rules; and manage Route 53 aliases.
On first use in an account, AWS may also need permission to create the
`AWSServiceRoleForCloudFrontVPCOrigin` service-linked role. Nimbus adds ingress rules and does
not remove existing ALB security-group rules; keep any non-CloudFront access you intend to retain
explicit in the platform stack.

## Private EKS NLB through CloudFront VPC Origins

Set `vpcOrigin.type` to `"nlb-vpc"` and provide the ARN of an existing internal IPv4 NLB.
Nimbus checks its region, AZs, subnets, security groups, and every listener; any TLS listener
is rejected because CloudFront VPC Origins do not support it. NLB origins use
`originProtocolPolicy: "http-only"` and default to HTTP port 80. Nimbus adds only an ingress
rule from `CloudFront-VPCOrigins-Service-SG` to the selected NLB security group.

The AWS Load Balancer Controller can create one internal NLB from Traefik's Kubernetes
`Service` of type `LoadBalancer`. Export that NLB ARN and security-group ID from the platform
stack, then pass them to Nimbus. Multiple app aliases share the same VPC Origin and NLB;
CloudFront forwards the viewer `Host` so Traefik routes to the right app. The request path is
viewer HTTPS → CloudFront-to-NLB HTTP → Traefik HTTP.

When using the controller's `aws-load-balancer-security-groups` annotation, attach a dedicated
NLB security group with only the ingress you intend to allow. The controller then stops
managing the NLB's frontend ingress rules; Nimbus adds the CloudFront service-managed group
rule and leaves any other existing ingress intact. Enable
`aws-load-balancer-manage-backend-security-group-rules` so the controller still opens the
required target security-group rules. Keep the NLB Service and its security group in the
platform stack; Nimbus owns the VPC Origin and its CloudFront ingress rule.

The NLB must use private eligible subnets with available IPv4 space and a VPC internet gateway,
must be in a supported region/AZ, must have a security group attached, and must not have a TLS
listener or dual-stack addressing. The Pulumi runner also needs ELBv2 `DescribeListeners` access
using the AWS SDK's standard credential chain, in addition to the CloudFront and EC2 permissions
described above. If a Pulumi AWS provider uses a custom `assumeRole`, the SDK preflight needs
equivalent AWS credentials.
