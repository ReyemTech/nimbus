# ServiceAccount kubectl Access and Documentation Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create scoped Kubernetes ServiceAccount access with a portable kubeconfig and fluent cluster APIs, while reorganizing Nimbus documentation by provider.

**Architecture:** A standalone ServiceAccount access factory creates a ServiceAccount, token Secret, and built-in/custom RBAC binding; its kubeconfig is a Pulumi secret output. Nimbus cluster factory outputs gain a fluent subtype whose methods call existing standalone cluster factories. Documentation is reorganized into a short root README, a docs index, provider guides, access guide, and focused example pages.

**Tech Stack:** TypeScript, Pulumi Kubernetes provider, YAML serialization, Vitest, Markdown.

**Spec:** `docs/superpowers/specs/2026-11-25-service-account-kubectl-access-design.md`

## Global Constraints

- The standalone service-account access factory and existing high-level factories remain available.
- Persistent service-account token and kubeconfig values are Pulumi secret outputs.
- `cluster-admin` is opt-in; the API never selects it by default.
- Nimbus cluster factory results expose fluent methods through a subtype; the public `ICluster` contract stays compatible with caller-created cluster objects.
- Fluent methods delegate to the existing standalone functions so resource semantics remain the same.
- Do not write kubeconfig credentials to the program's working directory.
- README stays a short entry point; provider behavior belongs in provider guides.

## Review Focus

- Kubernetes may populate a token Secret after initial creation; ensure generated kubeconfig output handles missing token/CA data clearly.
- Kubeconfig must embed the service-account token and cluster CA while selecting the correct API endpoint/context.
- Namespace bindings must reference the ServiceAccount namespace while constraining permissions to the configured target namespace.
- Custom Role/ClusterRole bindings must reject invalid scope combinations and must not create or widen caller-owned roles.
- All three Nimbus cluster providers must return the fluent subtype without importing provider-heavy modules in unrelated AWS-only factory paths.
- Documentation moves must preserve all AWS, Azure, Rackspace, Headlamp, CloudFront, autoscaling, tagging, SBOM, and state-ownership guidance and links.

## File Map

- `src/access/interfaces.ts` — typed scope/config/result interfaces for generated ServiceAccount access.
- `src/access/service-account.ts` — create the ServiceAccount, token Secret, RBAC binding, and secret kubeconfig output.
- `src/access/index.ts`, `src/index.ts` — export the standalone factory and its public types.
- `src/cluster/interfaces.ts`, `src/cluster/index.ts` — define/export the fluent subtype and method option types without adding required fields to `ICluster`.
- `src/cluster/fluent.ts` — attach cluster methods that delegate to the standalone factory APIs.
- `src/aws/cluster.ts`, `src/azure/cluster.ts`, `src/rackspace/cluster.ts`, `src/factories/cluster.ts` — return clusters with fluent operations.
- `tests/unit/service-account-access.test.ts` — ServiceAccount, scope binding, and kubeconfig coverage.
- `tests/unit/factories.test.ts` and provider unit tests — fluent delegation and provider output coverage.
- `README.md` — concise overview and navigation.
- `docs/README.md` — documentation index and provider/guides/example navigation.
- `docs/providers/aws.md`, `docs/providers/azure.md`, `docs/providers/rackspace.md` — provider options, features, constraints, and state ownership.
- `docs/guides/kubernetes-access.md` — ServiceAccount scopes, token handling, kubeconfig export, revocation, and alternatives.
- `docs/examples.md` plus `docs/examples/{aws,azure,multi-cloud,standalone}.md` — focused example index and content.
- `docs/api-reference.md` — concise cross-provider API reference with links to provider-specific details.
- `docs/superpowers/specs/2026-11-25-service-account-kubectl-access-design.md` — approved feature/design context.

### Task 1: Implement standalone ServiceAccount access factory

**Interfaces:**

- `createServiceAccountAccess(name: string, config: IServiceAccountAccessConfig): IServiceAccountAccess`
- `IServiceAccountAccessConfig` includes `cluster`, a typed `scope`, optional ServiceAccount `namespace` and name, and optional API `server` override.
- `scope` supports `{ type: "cluster", role: "cluster-admin" | "view" }`, `{ type: "namespace", namespace, role: "admin" | "edit" | "view" }`, or `{ type: "custom", namespace?, roleRef: { kind: "Role" | "ClusterRole", name } }`.
- `IServiceAccountAccess` exposes the ServiceAccount, token Secret, RBAC binding, and `kubeconfig: pulumi.Output<string>`.

- [x] **Step 1: Add failing scope and kubeconfig tests**

Test default ServiceAccount namespace/name, cluster-admin ClusterRoleBinding, cluster-view ClusterRoleBinding, namespace role binding target, valid custom Role/ClusterRole scopes, invalid custom scope combinations, endpoint and CA/token/context in generated kubeconfig, and secret marking.

- [x] **Step 2: Run focused tests to verify expected failures**

Run: `npm test -- --run tests/unit/service-account-access.test.ts`  
Expected: FAIL because the ServiceAccount factory and public types do not exist.

- [x] **Step 3: Add the typed public API**

Define the scope discriminated union, config, and result types in `src/access/interfaces.ts`; export them and `createServiceAccountAccess` through `src/access/index.ts` and `src/index.ts`.

- [x] **Step 4: Implement Kubernetes resources and kubeconfig output**

In `src/access/service-account.ts`, ensure the ServiceAccount namespace, create the named ServiceAccount and annotated `kubernetes.io/service-account-token` Secret, and create exactly one binding matching the selected scope. Build a standalone kubeconfig from the token Secret's `data.token` and `data.ca.crt` plus `config.server ?? cluster.endpoint`; mark the complete kubeconfig secret. Reject missing endpoint/token/CA and malformed custom scope with clear errors. Do not place the token in logs or plaintext configuration.

- [x] **Step 5: Run focused tests and typecheck**

Run: `npm test -- --run tests/unit/service-account-access.test.ts` and `npm run typecheck`.  
Expected: all access tests pass and TypeScript reports no errors.

### Task 2: Add fluent cluster operations

**Interfaces:**

- `IClusterFluentOperations` adds `createServiceAccountAccess`, `createAccessGateway`, `createPlatformStack`, `createObservabilityStack`, `createOperator`, and `createArgoCD` methods.
- `IClusterWithFluentOperations = ICluster & IClusterFluentOperations`; existing `ICluster` stays unchanged.
- Methods accept each factory's config with `cluster` omitted and supply `this` cluster to the existing factory.

- [x] **Step 1: Add failing fluent delegation tests**

Test each cluster method injects the owning cluster into the existing standalone factory, forwards the caller's config and name, and returns the standalone result unchanged. Verify Nimbus factory outputs expose the fluent subtype and a plain caller-constructed `ICluster` remains assignable to `ICluster`.

- [x] **Step 2: Run focused tests to verify expected failures**

Run: `npm test -- --run tests/unit/factories.test.ts`.  
Expected: FAIL because the fluent subtype and methods do not exist.

- [x] **Step 3: Define and export fluent cluster types**

Add the `IClusterFluentOperations` signatures and `IClusterWithFluentOperations` type without adding required operations to `ICluster`. Use distributive omission for union configs such as access-gateway providers.

- [x] **Step 4: Implement cluster operation delegation**

Add `withClusterFluentOperations(cluster)` in `src/cluster/fluent.ts`. Implement the six methods by calling the existing public standalone factory functions. Apply this helper to AWS EKS, Azure AKS, Rackspace cluster outputs, and the generic cluster factory return type. Keep resource helpers and existing fluent returned objects unchanged.

- [x] **Step 5: Run focused and full verification**

Run: `npm test -- --run tests/unit/factories.test.ts tests/unit/service-account-access.test.ts`, `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm run build`.  
Expected: all focused tests and checks pass.

### Task 3: Reorganize and audit documentation

**Interfaces:**

- Consumes the public access and fluent-cluster APIs from Tasks 1 and 2.
- Public docs include provider capability maps and complete examples for AWS, Azure, Rackspace, multi-cloud, and standalone use.

- [x] **Step 1: Create provider and guide destinations**

Add `docs/README.md`, `docs/providers/{aws,azure,rackspace}.md`, and `docs/guides/kubernetes-access.md`. Include EKS support/add-ons/autoscaling/tagging/CloudFront details for AWS; networking/AKS/DNS/Key Vault details for Azure; Rackspace modes and Pulumi state ownership; and ServiceAccount scope/token/export/revoke guidance in the access guide.

- [x] **Step 2: Split examples without dropping current coverage**

Move or reorganize current examples into AWS, Azure, multi-cloud, and standalone pages; leave `docs/examples.md` as an index with working anchors. Include examples for both standalone and fluent cluster APIs and the portable ServiceAccount kubeconfig workflow.

- [x] **Step 3: Rewrite the README and connect navigation**

Reduce the root README to product purpose, installation, one concise quick start, supported provider summary, and links to the docs index. Update the API reference to link provider-specific options instead of duplicating long sections. Audit `README.md`, `docs/*.md`, and examples for links, stale defaults, duplicated/conflicting instructions, and current feature coverage.

- [x] **Step 4: Verify docs and repository checks**

Run a local Markdown link check, `git diff --check`, `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, and `npm run build`.  
Expected: all local links resolve, no whitespace errors, and code checks pass.

## Execution Handoff

Implement in order: Task 1, Task 2, Task 3. Keep the work on `feat/service-account-kubeconfig`. After verification, commit, push, open a PR against `main`, and request Codex review; continue through review findings until the PR is ready for merge.
