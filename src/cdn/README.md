# CDN

`createCdn` provisions the trusted CloudFront edge used by applications that opt into the
edge-trust middleware. Each distribution has one primary `hostname` and may have additional
CloudFront `aliases`. Public custom origins keep the existing static client-host header. Private
VPC origins forward the viewer `Host`, allowing one Traefik ALB to route aliases by hostname.

The origin request policy excludes `Host` while forwarding all viewer headers, including the
CloudFront viewer-address and geo headers. Each origin request includes the configured origin
secret and the configured client-host header. `hostedZoneId` creates both Route 53 `A` and `AAAA`
aliases for every distribution; the cluster-managed origin DNS remains out of scope.

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
custom `originRequestPolicyId` for a private origin, it must forward `Host` for Traefik routing.
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

The deploying identity needs permission to manage CloudFront VPC Origins and distributions,
read the ALB and VPC subnet/route table/internet gateway/security-group metadata, add and remove
ALB security-group ingress rules, and manage Route 53 aliases. On first use in an account, AWS
may also need permission to create the `AWSServiceRoleForCloudFrontVPCOrigin` service-linked
role. Nimbus adds ingress rules and does not remove other existing ALB security-group rules;
keep any non-CloudFront access you intend to retain explicit in the platform stack.
