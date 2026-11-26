# Headlamp Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in Headlamp dashboard to `createPlatformStack`, infer plugins for installed Nimbus capabilities, and return a Tailscale-exposable service by default.

**Architecture:** A focused Headlamp component owns the upstream Helm release and plugin selection. `createPlatformStack` supplies installed cluster/platform features, orders Headlamp after relevant controllers, and includes it in `exposedServices`; the service remains private as `ClusterIP`.

**Tech Stack:** TypeScript, Pulumi Kubernetes Helm v3, upstream Headlamp Helm chart, Vitest, Markdown examples.

**Spec:** `docs/superpowers/specs/2026-11-25-headlamp-dashboard-design.md`

## Global Constraints

- Headlamp is opt-in; `headlamp.enabled` defaults to `false`.
- The Kubernetes Service defaults to `ClusterIP`; ingress is disabled.
- Headlamp uses its managed pod ServiceAccount and a Nimbus ClusterRole with `get`, `list`, and `watch` on all API resources by default; this includes Secret contents and custom resources. `authentication: "user-token"` keeps per-user token auth available and uses the built-in `view` role for the pod. Shared ServiceAccount auth must stay behind a trusted access proxy or private network.
- The upstream chart's default `cluster-admin` binding is replaced with read-only `view` by default.
- `headlamp.expose` defaults to `true` when Headlamp is enabled and only adds an `IExposedService` for the separate access gateway to consume.
- Auto-detected and caller-added plugins use explicit pinned versions; plugin watch/reload remains disabled.
- Keep current platform stack behavior unchanged when Headlamp is omitted or disabled.

## Review Focus

- EKS cert-manager add-on versus Helm cert-manager must select one plugin and create no duplicate controller.
- A Karpenter pool mixed with managed node pools must select the Karpenter plugin from the returned `cluster.nodePools`.
- Argo CD must only be inferred when `config.argocd.enabled` is true; document that the Artifact Hub plugin is third-party and read-only.
- Custom plugin entries must reject non-HTTPS/non-Artifact-Hub sources, empty names, and missing versions.
- A disabled or hidden Headlamp service must not appear in `components` or `exposedServices`; default exposure must use a stable service name and port.

---

## File Map

- `src/platform/interfaces.ts` — add `IHeadlampConfig`, plugin descriptor/ID types, and `headlamp` platform option.
- `src/platform/components/headlamp.ts` — resolve plugin set and deploy the Headlamp Helm chart with secure network/auth/RBAC defaults.
- `src/platform/components/index.ts` — export the focused deploy helper.
- `src/platform/stack.ts` — add default chart version entry, infer plugins from cluster/platform state, order release dependencies, and produce the Tailscale service output.
- `tests/unit/headlamp.test.ts` — focused plugin selection, chart values, and custom-plugin validation tests.
- `tests/unit/platform-stack.test.ts` — factory integration, default-off behavior, and Tailscale exposure coverage.
- `docs/api-reference.md` — public API and defaults.
- `docs/examples.md` and `examples/single-cloud-aws/index.ts` — AWS usage with optional Headlamp and Tailscale service handoff.
- `examples/single-cloud-aws/README.md` — explain private service, auth/RBAC, and plugin coverage.

### Task 1: Define plugin types and selection rules

**Files:**
- Modify: `src/platform/interfaces.ts`
- Create: `src/platform/components/headlamp.ts`
- Modify: `src/platform/components/index.ts`
- Test: `tests/unit/headlamp.test.ts`

**Interfaces:**
- Produces `IHeadlampPluginId = "cert-manager" | "karpenter" | "argocd"`.
- Produces `IHeadlampPluginConfig` with required `name`, `source`, and pinned `version`.
- Produces `IHeadlampPluginsConfig` with optional `disabled` IDs and `additional` plugin descriptors.
- Produces `IHeadlampConfig extends IPlatformComponentConfig` with `namespace`, `plugins`, `serviceAccountClusterRoleName`, and chart values inherited from the existing component config.
- Produces `resolveHeadlampPlugins(cluster: ICluster, config: Pick<IPlatformStackConfig, "argocd" | "certManager" | "headlamp">)` returning a deterministically ordered list of pinned plugin-manager entries.

- [x] **Step 1: Write focused failing plugin-selection tests**

Test `resolveHeadlampPlugins` to assert:

- EKS `cert-manager` add-on selects the cert-manager plugin once even when platform cert-manager is enabled.
- `config.certManager.enabled === false` and no EKS cert-manager add-on does not select the plugin.
- A Karpenter-mode node pool selects the Karpenter plugin.
- `config.argocd.enabled === true` selects the Argo CD plugin; absent/false config does not.
- `disabled` suppresses an inferred plugin, `additional` entries merge, duplicate names against inferred plugins are rejected, and invalid source/name/version inputs throw a clear error.
- Resolved plugin versions are pinned constants; no entry uses `latest`.

- [x] **Step 2: Run the focused test to verify the expected failures**

Run: `npm test -- --run tests/unit/headlamp.test.ts`
Expected: FAIL because the Headlamp types and resolver do not yet exist.

- [x] **Step 3: Add the public Headlamp and plugin interfaces**

Define the interfaces in `src/platform/interfaces.ts`; make `headlamp` optional in `IPlatformStackConfig` and re-export the types from `src/platform/index.ts` and `src/index.ts` following existing platform type exports.

- [x] **Step 4: Implement plugin selection and validation**

Add `resolveHeadlampPlugins` in `src/platform/components/headlamp.ts`. Use these pinned Artifact Hub packages: cert-manager `https://artifacthub.io/packages/headlamp/headlamp-plugins/headlamp_cert-manager` version `0.1.1`; Karpenter `https://artifacthub.io/packages/headlamp/headlamp-plugins/headlamp_karpenter` version `0.2.0`; and Argo CD `https://artifacthub.io/packages/headlamp/privilegedescalation/headlamp-argocd` version `0.1.3` (third-party publisher; read-only integration). Keep Prometheus supplied by the upstream chart's bundled static plugin, and do not install a second copy. Set the plugin-manager CLI version to pinned `0.1.1`.

- [x] **Step 5: Run focused resolver tests**

Run: `npm test -- --run tests/unit/headlamp.test.ts`
Expected: PASS for every plugin selection and validation case.

### Task 2: Deploy Headlamp and integrate it with the platform stack

**Files:**
- Modify: `src/platform/components/headlamp.ts`
- Modify: `src/platform/components/index.ts`
- Modify: `src/platform/stack.ts`
- Test: `tests/unit/headlamp.test.ts`
- Test: `tests/unit/platform-stack.test.ts`

**Interfaces:**
- Consumes `IHeadlampConfig` and `resolveHeadlampPlugins` from Task 1.
- Produces `deployHeadlamp(name, config, plugins, provider, chartVersion, dependsOn): k8s.helm.v3.Release`; plugin selection remains in the stack orchestrator.

- [x] **Step 1: Write Helm-release tests for secure defaults**

Assert the release uses the upstream `headlamp` chart/repository, configured/default namespace, private `ClusterIP`, disabled chart ingress, automatic pod ServiceAccount authentication by default, an all-resource read-only ClusterRole, per-user token mode with built-in `view` when selected, no plugin watch/reload, and plugin manager config for selected plugins.

- [x] **Step 2: Run focused tests to verify the expected failures**

Run: `npm test -- --run tests/unit/headlamp.test.ts`
Expected: FAIL because no Helm release is created.

- [x] **Step 3: Implement `deployHeadlamp`**

Create a Helm v3 release with chart repository `https://kubernetes-sigs.github.io/headlamp/`, `fullnameOverride: "headlamp"`, namespace default `headlamp`, service type `ClusterIP`, and ingress disabled. Ensure the namespace through `ensureNamespace` and make the release depend on it. In automatic ServiceAccount mode, create a unique Nimbus ClusterRole with read-only access to all API resources and make the Helm release depend on it. Disable the chart-managed ClusterRoleBinding and create a separate Pulumi ClusterRoleBinding after the Helm release because Kubernetes roleRefs are immutable. In `user-token` mode, use the built-in `view` role without creating the broad role. Render plugin-manager config as YAML with explicit versions. Deep-merge Nimbus defaults with caller `values`, then re-apply Nimbus-owned service type, ingress, auth mode, plugin-watch, plugin-manager, and ServiceAccount RoleBinding settings so chart overrides cannot weaken them. Allow caller values to disable the non-security static Prometheus plugin. Honor `config.serviceAccountClusterRoleName` when provided.

- [x] **Step 4: Write platform-stack integration tests**

Assert Headlamp is omitted by default and when disabled; enabled release depends on relevant installed platform controllers; and `exposedServices` includes the Headlamp service by default but omits it when `headlamp.expose === false`.

- [x] **Step 5: Wire Headlamp into `createPlatformStack`**

Add `headlamp: undefined` to `DEFAULT_VERSIONS`. After cert-manager/Argo CD deployment decisions are known, call `deployHeadlamp` with its explicit chart version or the default and dependencies on the namespace plus enabled cert-manager/Argo CD releases. Store the release under `components.headlamp`. Append `{ name: "headlamp", originalName: "headlamp", namespace, port: 80, label: "headlamp" }` to `exposedServices` unless explicitly hidden.

- [x] **Step 6: Run focused platform tests**

Run: `npm test -- --run tests/unit/headlamp.test.ts tests/unit/platform-stack.test.ts`
Expected: PASS with existing platform stack behavior unchanged and Headlamp defaults covered.

### Task 3: Document configuration and the Tailscale workflow

**Files:**
- Modify: `docs/api-reference.md`
- Modify: `docs/examples.md`
- Modify: `examples/single-cloud-aws/index.ts`
- Modify: `examples/single-cloud-aws/README.md`

**Interfaces:**
- Consumes `IHeadlampConfig` and the `IPlatformStack.exposedServices` output.
- Produces public docs and an AWS example demonstrating `headlamp: { enabled: true }` followed by `createAccessGateway(... services: platform.exposedServices)`.

- [x] **Step 1: Document typed options and plugin inference**

Describe disabled-by-default behavior, private ClusterIP, plugin selection rules, plugin additions/exclusions, pinned versions, the third-party/read-only provenance of the selected Argo CD plugin, and the absence of dedicated plugins for other Nimbus components that remain visible through native CRD views.

- [x] **Step 2: Add the AWS EKS usage example**

Enable Headlamp in `createPlatformStack`, include `platform.exposedServices` when configuring the existing Tailscale gateway, and show `kubectl port-forward` as an alternative. State that Tailscale exposure does not replace per-user Kubernetes authentication or RBAC.

- [x] **Step 3: Review the rendered docs diff**

Run: `git diff --check`
Expected: no whitespace errors; example matches the exported types and actual service naming.

## Execution Handoff

Implement in this order: Task 1, Task 2, then Task 3. Keep the implementation and API in this branch; do not create a commit or PR until requested.
