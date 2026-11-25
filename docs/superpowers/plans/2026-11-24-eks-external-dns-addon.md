# EKS ExternalDNS Add-on Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the 3.10.1 EKS scaffold workarounds and use a zone-scoped EKS ExternalDNS add-on with Pod Identity on AWS EKS.

**Architecture:** Keep `IPlatformStack.components` Helm-only for source compatibility and expose AWS resources in an optional provider-resource map. AWS EKS + Route 53 uses an `aws.eks.Addon` with Pod Identity and least-privilege Route 53 policies; other providers keep Helm. Existing Helm users migrate in two applies by disabling ExternalDNS, then re-enabling it with the previous domain filters and TXT owner ID.

**Tech Stack:** TypeScript, Pulumi AWS, Pulumi Kubernetes, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-24-eks-external-dns-addon-design.md`

## Global Constraints

- AWS EKS + Route 53 must not create an IAM user, access key, or AWS credential Kubernetes Secret. Detect EKS by `cluster.nativeResource instanceof aws.eks.Cluster`; AWS non-EKS clusters remain on Helm.
- Route 53 record mutation and record listing permissions are limited to selected hosted-zone ARNs.
- The EKS community add-on uses service account `external-dns` in namespace `external-dns` and Pod Identity.
- Non-EKS or non-AWS ExternalDNS remains Helm-based.
- ExternalDNS defaults remain `sources: ["ingress", "service", "traefik-proxy"]` and `policy: "sync"`; registry is `txt`.
- The two-apply migration preserves domain filters and the existing TXT owner ID.
- Do not run Pulumi against the live AWS stack.

## Review Focus

- Explicit hosted-zone IDs override filter lookup; absent IDs require nonempty filters and every exact filtered zone must resolve. Ambiguous public/private zones require explicit IDs.
- Route 53 IAM statements use zone ARNs for record changes/listing and do not attach `AmazonRoute53FullAccess`.
- EKS route53 mode creates no static credentials or Kubernetes Secrets, including the cert-manager DNS-01 path.
- Existing Helm users can disable ExternalDNS for one apply before the native add-on is created.
- Multiple observability stacks keep distinct release names under Helm's limit; Traefik dependencies reach the Helm Release resource.

---

### Task 1: Expose EKS factory options and storage tiers

**Files:**
- Modify: `src/factories/types.ts`
- Modify: `src/aws/cluster.ts`
- Test: `tests/unit/aws-cluster.test.ts`
- Test: `tests/unit/factories.test.ts`

**Interfaces:**
- `IAwsProviderOptions` mirrors the supported `IEksOptions` fields, including `authenticationMode`, `bootstrapClusterCreatorAdminPermissions`, `upgradePolicy`, `nodeGroupAmiType`, `nodeGroupInstanceTags`, and `kubernetesProviderRoleArn`.
- AWS `ICluster.storageTiers` returns `config.storageTiers`.

- [ ] Write a factory/cluster test showing the public factory accepts and forwards EKS options and the AWS result returns storage tiers.
- [ ] Run the focused tests and verify the expected missing-property/forwarding failure.
- [ ] Add the option fields and return storage tiers from `createEksCluster`.
- [ ] Run `npm test -- --run tests/unit/aws-cluster.test.ts tests/unit/factories.test.ts` and verify pass.

### Task 2: Fix observability, Helm naming, and Traefik dependencies

**Files:**
- Modify: `src/platform/interfaces.ts`
- Modify: `src/platform/stack.ts`
- Modify: `src/platform/components/traefik.ts`
- Modify: `src/observability/stack.ts`
- Test: `tests/unit/platform-stack.test.ts`
- Test: `tests/unit/observability-stack.test.ts`

**Interfaces:**
- `IPlatformComponentConfig.dependsOn?: ReadonlyArray<pulumi.Resource>` is forwarded to the Traefik Helm release.
- Traefik alerts are registered by `createObservabilityStack` after its Prometheus release and namespace.
- kube-prometheus-stack uses a deterministic sanitized release name no longer than 53 characters without changing its Pulumi logical resource name.

- [ ] Add tests for Traefik `dependsOn`, PrometheusRule namespace/chart ordering, and long-name release-name bounds/uniqueness.
- [ ] Run focused tests and verify each test fails against the current behavior.
- [ ] Move Traefik PrometheusRule creation to the observability stack, where it can depend on kube-prometheus-stack.
- [ ] Set the bounded explicit Helm release name and forward Traefik dependencies.
- [ ] Run both focused test files and verify pass.

### Task 3: Add the AWS EKS Route 53 ExternalDNS add-on

**Files:**
- Modify: `src/platform/interfaces.ts`
- Modify: `src/platform/stack.ts`
- Modify: `src/platform/components/external-dns.ts`
- Modify: `src/cluster/interfaces.ts`
- Modify: `src/aws/cluster.ts`
- Create: `src/platform/components/external-dns-eks.ts`
- Modify: `src/platform/components/index.ts`
- Test: `tests/unit/platform-stack.test.ts`
- Create: `tests/unit/external-dns-eks.test.ts`

**Interfaces:**
- `IExternalDnsConfig` gains `hostedZoneIds?: ReadonlyArray<pulumi.Input<string>>` and `addonVersion?: pulumi.Input<string>`; existing `domainFilters` and `values` continue to configure ExternalDNS.
- `ICluster` gains optional `providerResources?: Readonly<Record<string, pulumi.Resource>>`; the AWS cluster reports its EKS Pod Identity Agent add-on when created.
- `IPlatformStack` keeps `components` as Helm releases and adds `providerResources?: Readonly<Record<string, pulumi.Resource>>` for the native EKS add-on and IAM resources.
- `deployEksExternalDns(name, cluster, config, awsProvider)` creates a `Route53` permission role, its inline policy, and the `aws.eks.Addon`; the add-on association maps `external-dns` to that role.

- [ ] Add tests for EKS add-on name/version/configuration, Pod Identity account/namespace/service account, explicit zone IDs, exact domain-filter fallback, ambiguous zones, invalid empty scopes, policy resource ARNs/actions, and no IAM user/access-key/Kubernetes credential Secret.
- [ ] Add platform branch tests proving AWS EKS + Route 53 uses the add-on while Azure/non-AWS and AWS non-EKS paths still use Helm.
- [ ] Run the focused tests and verify they fail against current code.
- [ ] Implement zone resolution, zone-scoped IAM policy, Pod Identity role, and EKS add-on registration.
- [ ] Ensure Pod Identity Agent exists once, reusing the AWS cluster's add-on when present and creating it otherwise.
- [ ] Move the Route 53 cert-manager DNS-01 flow on EKS to a separate Pod Identity role/association with no AWS credential Secret; retain the current path outside EKS.
- [ ] Build add-on configuration from existing defaults plus supported `values` overrides; keep Helm `version` semantics outside the EKS branch and use `addonVersion` for the EKS add-on.
- [ ] Run focused tests and verify pass.

### Task 4: Document configuration and Helm migration

**Files:**
- Modify: `docs/api-reference.md`
- Modify: `docs/examples.md`

- [ ] Add an AWS EKS + Route 53 ExternalDNS example with zone scoping, add-on version, preserved sources/registry/TXT owner/policy, and no static credentials.
- [ ] Document add-on configuration schema constraints, Pod Identity permissions, and the two-apply migration (`enabled: false` apply; then `enabled: true` apply), including preserving the existing TXT owner ID.
- [ ] Document remaining Helm path behavior for non-EKS providers.
- [ ] Review examples and docs for accurate input/output types.

### Task 5: Full verification and review

**Files:**
- Verify all task files.

- [ ] Run `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm test`, `npm run build`, and `git diff --check`.
- [ ] Review the full diff against the spec and record any rulings or deferred minors in the execution ledger.
