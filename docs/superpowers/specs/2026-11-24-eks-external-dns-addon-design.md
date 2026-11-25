# EKS ExternalDNS Add-on and 3.10.1 Follow-up Design

## Intent

Remove the Nimbus consumer workarounds reported after the 3.10.1 foundation update and move AWS EKS Route 53 ExternalDNS from a Helm release with static credentials to the EKS community add-on with Pod Identity. Preserve existing Helm-based ExternalDNS behavior for non-EKS or non-AWS clusters.

## Goals

- Expose all supported EKS options through `IAwsProviderOptions` and return EKS `storageTiers` through `ICluster`.
- Ensure Traefik Prometheus rules have a namespace and depend on the Prometheus chart that selects them.
- Keep kube-prometheus-stack's rendered Helm release name within Helm's 53-character limit.
- Let callers order Traefik after externally managed dependencies such as the AWS Load Balancer Controller.
- For AWS EKS + Route 53, install/manage add-on `external-dns` through `aws.eks.Addon`, with Pod Identity on service account `external-dns`. Detect EKS by the AWS EKS native resource so custom non-EKS AWS clusters retain Helm.
- Scope Route 53 changes to selected hosted zones and grant only necessary record/list permissions. Do not create IAM users, access keys, or AWS credential Secrets for this EKS path.
- Preserve ExternalDNS domain filters, sources, TXT registry/ownership, record policy, and the automatic Route 53 cert-manager issuer behavior.
- Keep the current Helm path and its credential behavior for other cluster/provider combinations.

## Non-goals

- Deploying the AWS Load Balancer Controller from Nimbus. Callers can supply it as a Pulumi dependency for Traefik.
- Changing Route 53 authentication for non-EKS clusters.
- Rewriting consumer-specific Helm values that are not accepted by the ExternalDNS add-on configuration schema.
- Running Pulumi against or changing the live AWS stack.

## Approaches

### ExternalDNS deployment

1. **Native EKS add-on for AWS EKS + Route 53; Helm otherwise (selected).** This meets AWS's community add-on lifecycle and Pod Identity requirements while preserving other providers' existing path.
2. Keep Helm on EKS and replace static keys with a standalone Pod Identity association. This would avoid static credentials but would not meet the requested EKS add-on lifecycle and compatibility management.

### Hosted-zone permission scope

1. **Use explicit hosted-zone IDs when provided, otherwise resolve exact zones from `domainFilters` (selected).** This supports non-root filters with explicit IDs while retaining existing configurations that already name hosted zones. Empty filters without explicit IDs fail clearly rather than creating a wildcard record-change policy. If an exact name matches both public and private hosted zones, require explicit IDs to disambiguate.
2. Require hosted-zone IDs for every AWS EKS Route 53 stack. This is simpler but forces an API/config migration for consumers whose domain filters already identify their hosted zones.

### Helm-to-add-on ownership migration

There are no current EKS deployments using ExternalDNS in the user's stack, so new AWS EKS + Route 53 deployments use the add-on path directly. Other consumers may have a Helm-managed release, so Nimbus documentation will include a two-apply migration without adding a temporary runtime flag:

1. Set `externalDns.enabled: false` and apply. Pulumi removes the Helm release and its legacy IAM user/access key/Secrets; existing DNS records remain in Route 53 while the controller is stopped.
2. Re-enable ExternalDNS and apply. Nimbus creates the EKS add-on, Pod Identity roles/associations, and the cert-manager issuer path without static AWS credentials.

Before switching, preserve the existing domain filters and TXT owner ID. Read the old Helm values (including any `values.txtOwnerId`) and configure the same owner ID for the EKS add-on so it can continue managing records it previously owned. This short controller interruption avoids simultaneous Helm and EKS ownership of the same Kubernetes resources.

## Design

### EKS option and cluster outputs

- Add the already-supported EKS options to `IAwsProviderOptions`, including authentication mode, creator-admin bootstrap, upgrade support policy, managed-node AMI type, instance tags, and Kubernetes-provider role ARN.
- Return `config.storageTiers` from `createEksCluster`, matching the declared `ICluster` contract and other cluster providers.
- Expose the EKS Pod Identity Agent resource in optional provider-specific cluster resources. `createEksCluster` will report the agent when it already creates one for EBS CSI; the platform stack can create it when ExternalDNS needs Pod Identity and it is absent. This prevents duplicate add-on registration.

### Platform ordering and Helm naming

- Move Traefik alert rule creation into the observability stack, after kube-prometheus-stack is created. The observability stack already owns the `observability` namespace and Prometheus release; this avoids duplicate Namespace resources and lets the rule depend on the chart.
- Set a deterministic, sanitized, bounded release name for kube-prometheus-stack while preserving its Pulumi logical resource name. Derive Grafana service discovery from the release status as it does today.
- Add a typed `dependsOn` list to Traefik configuration and pass it to the Helm Release resource options. The scaffold can pass its AWS Load Balancer Controller Release directly without resource transformations.

### EKS ExternalDNS add-on and IAM

- Detect AWS EKS Route 53 in `createPlatformStack`. Manage an EKS community add-on named `external-dns`; expose an add-on version option separately from the Helm chart `version` and serialize the add-on configuration to `configurationValues`.
- Build configuration from Nimbus defaults plus supported ExternalDNS settings: AWS provider, `domainFilters`, current sources (`ingress`, `service`, `traefik-proxy`), `policy: sync`, TXT registry, and caller ownership/configuration overrides. Keep Helm-only `version` and `values` semantics on other clusters; document that EKS `values` must conform to the selected add-on version's EKS configuration schema.
- Create a Pod Identity role with the `pods.eks.amazonaws.com` trust principal. Scope `ChangeResourceRecordSets` and `ListResourceRecordSets` to the resolved hosted-zone ARNs; grant the necessary hosted-zone listing action on `*` because Route 53 list APIs do not accept per-zone resource ARNs. Do not attach `AmazonRoute53FullAccess`.
- Configure the add-on's Pod Identity association for namespace/service account `external-dns`. Ensure the Pod Identity Agent add-on exists first.
- Preserve the automatic cert-manager DNS-01 issuer by using a separate Pod Identity role/association for the cert-manager service account when cert-manager is enabled. Its policy includes the additional Route 53 change-status read permission it needs. Do not emit static credentials or Secrets on EKS.
- Expose native provider resources separately on `IPlatformStack` so the existing Helm-only `components` map remains source-compatible. The AWS add-on appears in this provider-resource map, not as a Helm Release.
- For non-EKS/other-provider Route 53, retain the existing Helm, credentials override, and IAM-user fallback behavior.
- Document the two-apply Helm-to-add-on migration, including retaining the existing TXT owner ID to preserve record ownership.

## Review focus

- Verify the exact ExternalDNS EKS add-on configuration schema for selected versions; EKS validates this schema per add-on version.
- Verify the documented two-apply migration removes the Helm release before creating the EKS add-on and preserves DNS records/TXT ownership.
- Ensure the cert-manager Pod Identity association is ordered with the chart and DNS-01 issuer, and no EKS AWS credential Secrets are created.
- Ensure add-on policy scopes record mutations to selected zone ARNs and does not include broad managed policies.

## Acceptance checks

- AWS factory options accept the native EKS fields without type intersections; AWS `ICluster.storageTiers` is populated.
- PrometheusRule namespace and chart dependencies are explicit; long stack names still produce valid Helm release names.
- Traefik can depend on an externally created Load Balancer Controller release.
- AWS EKS + Route 53 creates the ExternalDNS community add-on, an EKS Pod Identity association, and zone-scoped IAM permissions with no IAM user, access key, or AWS credential Secret.
- Existing ExternalDNS defaults and caller overrides survive the provider-specific switch; other providers still create the Helm chart.
- Tests cover AWS EKS and non-EKS branches, zone resolution and IAM policy scope, credential resource absence, add-on dependencies/configuration, and migration staging.
