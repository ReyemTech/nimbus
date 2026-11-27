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

## Round 1 review fixes

### Test-first evidence

- **RED:** Added regression tests before production fixes. The first focused run failed 14 assertions: Descheduler CronJob PDB gating/native PDB values, OAuth2 Proxy native PDB and conflict detection, mixed raw/typed Trivy settings, Tailscale selector/scheduling rejection, WireGuard replica/spread behavior and selector, and scheduling/PDB opt-out assertions.
- **GREEN:** `npx vitest run tests/unit/platform-pod-disruption-budget.test.ts tests/unit/access-pod-disruption-budget.test.ts` passed: 68 tests in 2 files.
- **Full suite:** `npm test` passed: 47 files, 1,013 tests.
- `npm run typecheck` passed.
- ESLint passed for changed files with no warnings.
- Prettier check passed for changed files.

### Review findings addressed

1. **Descheduler:** Preserved the chart's default `CronJob` behavior. Nimbus now only sets a native chart PDB when `values.kind` is `Deployment`; a typed enabled PDB or typed scheduling configuration without Deployment mode throws with a direct message. The chart's own values document `kind: CronJob` as default and its PDB as Deployment-only. See [upstream Descheduler values](https://github.com/kubernetes-sigs/descheduler/blob/master/charts/descheduler/values.yaml).
2. **Tailscale and WireGuard scheduling:** Tailscale chart template hard-codes one replica and exposes no operator Deployment placement values, so Nimbus rejects typed scheduling rather than silently ignoring it. WireGuard maps typed replicas to the chart's `replicaCount`, checks conflict against raw values, and rejects typed spread because chart template hard-codes its topology spread rule. See [Tailscale Deployment template](https://github.com/tailscale/tailscale/blob/main/cmd/k8s-operator/deploy/chart/templates/deployment.yaml), [Tailscale values](https://github.com/tailscale/tailscale/blob/main/cmd/k8s-operator/deploy/chart/values.yaml), and [WireGuard Deployment template](https://github.com/bryopsida/wireguard-chart/blob/main/helm/wireguard/templates/deployment.yaml).
3. **Trivy Operator merge order:** Raw chart values are merged first, then the final resolved `operator` map is applied. Regression coverage verifies raw operator settings survive alongside typed replicas and spread.
4. **OAuth2 Proxy PDB:** Typed PDBs now map to the chart-native `podDisruptionBudget` values, and mixed typed/raw PDB configuration throws. No parallel standalone budget is created. Upstream documents `podDisruptionBudget`, `replicaCount`, and `topologySpreadConstraints`; see [chart values](https://github.com/oauth2-proxy/manifests/blob/main/helm/oauth2-proxy/values.yaml) and [Deployment template](https://github.com/oauth2-proxy/manifests/blob/main/helm/oauth2-proxy/templates/deployment.yaml).
5. **Access resource tests:** Added `{ enabled: false }` coverage for controller and CoreDNS budgets, WireGuard replica mapping and raw conflict checks, typed spread rejection for unsupported charts, and exact chart selector assertions.

### Selector evidence

- **Tailscale:** Official Deployment template uses `matchLabels: { app: <fullname> }`; chart values document the namespaced resource default as `operator`. The PDB now selects `{ app: "operator" }`.
- **WireGuard:** Official Deployment template sets both selector and pod label `app: "{{ .Release.Name }}-wireguard"`. Nimbus release name is `<gateway-name>-wireguard`, so the PDB selects `app: "<gateway-name>-wireguard-wireguard"`.
- The Helm charts are still unpinned and no local Helm rendering was run. Selector evidence was verified from the upstream templates instead.

### Round 1 changed files

- `src/platform/components/descheduler.ts`
- `src/platform/components/oauth2-proxy.ts`
- `src/platform/components/trivy-operator.ts`
- `src/access/tailscale.ts`
- `src/access/wireguard.ts`
- `tests/unit/platform-pod-disruption-budget.test.ts`
- `tests/unit/access-pod-disruption-budget.test.ts`

## Round 2 review fixes

### Test-first evidence

- **RED:** Before production fixes, `npx vitest run tests/unit/platform-pod-disruption-budget.test.ts tests/unit/access-pod-disruption-budget.test.ts` produced **8 failing tests**. They covered raw Descheduler PDBs under CronJob mode, loss of user Trivy values, Tailscale override selectors, WireGuard HPA/DaemonSet replica behavior, native PDB mapping, and disabled/conflicting budget cases.
- **Focused GREEN:** The same command passed **72 tests in 2 files**.
- **Full suite:** `npm test` passed **47 files, 1,017 tests**.
- `npm run typecheck` passed.
- ESLint passed on all changed TypeScript and test files.
- Prettier check and `git diff --check` passed.

### Changes and upstream evidence

1. **Descheduler raw PDB gating:** Enabled raw `values.podDisruptionBudget` is now rejected when `values.kind` is absent or not `Deployment`. Disabled raw budgets remain permissible; default CronJob behavior is preserved. The chart documents the CronJob default and Deployment-only PDB support in [upstream values](https://github.com/kubernetes-sigs/descheduler/blob/master/charts/descheduler/values.yaml).
2. **WireGuard autoscaling and DaemonSet:** Typed replicas now turn off the chart's default HPA so the requested `replicaCount` is effective. Explicit raw `autoscaling.enabled: true` conflicts with typed replicas and fails. Typed replicas are rejected with `daemonSet: true`; implicit replica-derived budget calculation is avoided for DaemonSets, and a typed enabled PDB there requires an explicit bound.
3. **WireGuard native PDB:** Removed Nimbus's standalone PDB. Typed policies map to `disruptionBudget` chart values, which render the native chart PDB. Upstream [values](https://raw.githubusercontent.com/bryopsida/wireguard-chart/main/helm/wireguard/values.yaml) declare `disruptionBudget.enabled` and integer `minAvailable`; the [PDB template](https://raw.githubusercontent.com/bryopsida/wireguard-chart/main/helm/wireguard/templates/pdb.yaml) renders only `minAvailable` and selects `app: <release>-wireguard`. Nimbus maps inferred `maxUnavailable` to `minAvailable` using the fixed configured replica count, rejects explicit `maxUnavailable` (the chart cannot represent it), and rejects percentage `minAvailable` (chart values are integer-only). Raw and typed native PDB settings conflict explicitly.
4. **Trivy raw values:** User `values.trivy` are merged over Nimbus defaults, preserving existing chart settings such as `mode` while allowing raw override of defaults.
5. **Tailscale selector overrides:** The selector now follows the upstream `fullname` helper's exact default/override rules, including `nameOverride`, `fullnameOverride`, `contains` behavior, truncation, and trailing-dash trimming. Evidence: [Deployment template](https://github.com/tailscale/tailscale/blob/main/cmd/k8s-operator/deploy/chart/templates/deployment.yaml) selects `app: <fullname>`; the [fullname helper](https://raw.githubusercontent.com/tailscale/tailscale/main/cmd/k8s-operator/deploy/chart/templates/_helpers.tpl) defines default `operator` and both override rules.
6. **Tailscale scheduling note correction:** The chart fixes operator replicas at one and does not expose typed spread settings for the operator Deployment. It does support raw `operatorConfig.nodeSelector`, `affinity`, and `tolerations`; Nimbus's error now says raw chart placement values can be used.

### Round 2 changed files

- `src/platform/components/descheduler.ts`
- `src/platform/components/trivy-operator.ts`
- `src/access/tailscale.ts`
- `src/access/wireguard.ts`
- `tests/unit/platform-pod-disruption-budget.test.ts`
- `tests/unit/access-pod-disruption-budget.test.ts`

Helm rendering was not run. Upstream sources are current `main` branches and the charts remain unpinned, so exact installed chart versions can still differ from the inspected sources.
