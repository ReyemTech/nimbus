# Task 3B Report

## Outcome

Implemented Task 3B in commit `74e4b2e` (`feat: add remaining controller disruption budgets`).

## Test-first evidence

- **RED:** Before production edits, `npx vitest run tests/unit/platform-pod-disruption-budget.test.ts` failed 6 assertions: each of Descheduler, OAuth2 Proxy, and Trivy Operator lacked a PDB, and did not map typed replicas into chart values.
- **GREEN:** Focused platform and access tests passed: 62 tests across 2 files. The full suite passed: 47 files, 1,007 tests.
- `npm run typecheck` passed.
- ESLint for changed source and test files passed without warnings after removing an unused test directive.
- Prettier check passed for all changed TypeScript files.

## Implementation

- Added typed PDB and pod scheduling mapping to Descheduler, OAuth2 Proxy, and Trivy Operator.
- Added typed controller PDB settings for Tailscale and WireGuard.
- Added separate PDBs and replica/spread mapping for Nimbus-created CoreDNS and Nginx access Deployments.
- Added resource-level tests for selector values, workload replicas, release/deployment dependencies, and separation of DNS and proxy budgets.
- `src/platform/stack.ts` already forwards the complete component config to all three deploy functions, so no stack call-site change was needed.

## Chart/resource evidence and remaining limitations

- Consulted authoritative upstream chart sources: [Descheduler values](https://github.com/kubernetes-sigs/descheduler/blob/master/charts/descheduler/values.yaml), [OAuth2 Proxy values](https://github.com/oauth2-proxy/manifests/blob/main/helm/oauth2-proxy/values.yaml), [OAuth2 Proxy Deployment template](https://github.com/oauth2-proxy/manifests/blob/main/helm/oauth2-proxy/templates/deployment.yaml), and [Trivy Operator values](https://github.com/aquasecurity/trivy-operator/blob/main/deploy/helm/values.yaml).
- OAuth2 Proxy documents `replicaCount`, `podDisruptionBudget`, and `topologySpreadConstraints`; its deployment selector is rendered from the chart selector helper.
- Trivy Operator uses `operator.replicas`; this implementation maps replicas there. Its chart release is unpinned and no Helm render was run.
- Descheduler's chart defaults to `kind: CronJob`; its built-in PDB is only rendered for `kind: Deployment`. Nimbus leaves that chart default intact while this implementation registers a standalone Deployment PDB using the inferred standard labels. This behavior needs correction or explicit Deployment mode before treating Descheduler PDB behavior as verified.
- Tailscale and WireGuard chart selectors and scheduling value paths were not confirmed by rendered manifests. Chart versions are unpinned; no chart render was available. These selectors and typed controller replica mappings remain unverified.
- Exact Trivy Operator selector labels and Trivy/Descheduler chart template selectors were not confirmed through rendered manifests.

## Changed files

- `src/access/interfaces.ts`
- `src/access/tailscale.ts`
- `src/access/wireguard.ts`
- `src/access/dns.ts`
- `src/access/proxy.ts`
- `src/platform/components/descheduler.ts`
- `src/platform/components/oauth2-proxy.ts`
- `src/platform/components/trivy-operator.ts`
- `tests/unit/platform-pod-disruption-budget.test.ts`
- `tests/unit/access-pod-disruption-budget.test.ts`
