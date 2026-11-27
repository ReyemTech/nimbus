# Task 4 Report: Observability, Cache, and Direct Nimbus Controllers

## Status

Implemented component-level disruption budgets and scheduling for Prometheus, Grafana, Alertmanager, single-binary Loki, kube-state-metrics, uptime Kuma, Redis master/replicas, the Nimbus Redis master tracker, and the Trivy exposure classifier. Alloy DaemonSets and batch jobs receive no PDBs.

The shared PDB option remains opt-in: omitting `podDisruptionBudget` does not add a Nimbus-managed budget. An explicit empty config uses the shared one-replica/multi-replica defaults. Redis chart PDBs are mapped using `master.pdb` and `replica.pdb` values. Nimbus-owned Deployments receive exact app selectors and PDB dependency ordering.

The Trivy classifier configuration type now accepts the shared policy and scheduling fields in `src/platform/interfaces.ts`.

## RED

Command:

```sh
npm test -- tests/unit/observability-pod-disruption-budget.test.ts tests/unit/cache-pod-disruption-budget.test.ts
```

Result before implementation: **2 test files failed; 4 tests failed and 1 passed**. Assertions showed missing Redis controller PDB values and tracker replicas, missing observability component PDBs and Loki spread values. An earlier harness iteration exposed mock setup errors; those were corrected before using the RED result.

## GREEN

Focused command:

```sh
npm test -- tests/unit/observability-pod-disruption-budget.test.ts tests/unit/cache-pod-disruption-budget.test.ts
```

Result after implementation: **2 test files passed; 8 tests passed**.

Full command:

```sh
npm test
```

Result: **49 test files passed; 1,026 tests passed**.

Typecheck:

```sh
npm run typecheck
```

Result: **passed**.

Lint:

```sh
npx eslint src/cache/cache.ts src/cache/interfaces.ts src/observability/interfaces.ts src/observability/stack.ts src/platform/interfaces.ts src/platform/components/trivy-exposure-classifier.ts tests/unit/cache-pod-disruption-budget.test.ts tests/unit/observability-pod-disruption-budget.test.ts
```

Result: **passed with no output**.

Formatting:

```sh
npx prettier --check src/cache/cache.ts src/cache/interfaces.ts src/observability/interfaces.ts src/observability/stack.ts src/platform/interfaces.ts src/platform/components/trivy-exposure-classifier.ts tests/unit/cache-pod-disruption-budget.test.ts tests/unit/observability-pod-disruption-budget.test.ts
```

Result: **all files use Prettier code style**.

## Chart inspection and limits

No Helm chart packages or rendered templates are vendored in this checkout. The configured chart versions are optional and commonly left unset, so chart behavior can change as upstream defaults change. I checked the current official chart references while implementing:

- [Bitnami Redis values](https://github.com/bitnami/charts/blob/main/bitnami/redis/README.md) documents the `master.pdb` and `replica.pdb` paths, `replica.replicaCount`, and the supported PDB fields.
- [Prometheus Community kube-state-metrics values](https://github.com/prometheus-community/helm-charts/blob/main/charts/kube-state-metrics/values.yaml) uses `replicas`, affinity, topology spread, and a native `podDisruptionBudget` value.
- [Grafana Loki single-binary values](https://github.com/grafana/loki/blob/main/production/helm/loki/values.yaml) documents `singleBinary.replicas`; the single-binary template consumes `singleBinary.topologySpreadConstraints`.

The Nimbus-managed PDB selectors for chart workloads use the standard chart name/instance labels; Loki single-binary additionally selects its component label. The uptime Kuma chart is not vendored, so its selector/value paths could not be confirmed against the exact deployed chart version. Loki distributed mode has multiple independent controllers; shared typed PDB/scheduling input now fails fast in that mode rather than creating an unmatched single-binary budget. Per-workload distributed Loki policies remain unsupported. This checkout cannot verify those chart selectors against the rendered release manifests.

# Task 4 Round 1 Fix Report

Base: `6e7065d`

## RED

Command:

```text
npm test -- tests/unit/observability-pod-disruption-budget.test.ts tests/unit/cache-pod-disruption-budget.test.ts
```

Result after migrating the suite to Pulumi resource mocks: **failed as expected**. New expectations showed that Uptime Kuma accepted unsupported `scheduling.replicas` and raw native PDB conflicts were not rejected. The first mock-harness pass also exposed a test setup issue (the cache provider argument and mocked namespace were not real Pulumi resources); the harness was corrected before GREEN.

## GREEN

Focused command:

```text
npm test -- tests/unit/observability-pod-disruption-budget.test.ts tests/unit/cache-pod-disruption-budget.test.ts
```

Actual result:

```text
Test Files  2 passed (2)
Tests       10 passed (10)
Duration    919ms
Exit code    0
```

Full suite command: `npm test`

Actual result:

```text
Test Files  49 passed (49)
Tests       1028 passed (1028)
Duration    7.74s
Exit code    0
```

Additional verification:

```text
npm run typecheck                                      passed
npx eslint <all changed source and test files>         passed
npx prettier --check <all changed source and test files> passed
```

## Changes

- Converted observability/cache tests to `pulumi.runtime.setMocks`; assertions inspect registered Helm releases, Deployments, and PDBs.
- Distributed Loki now maps shared scheduling and PDB policy independently to read, write, backend, gateway, compactor, distributor, ingester, querier, query frontend, query scheduler, index gateway, and ruler, with component selectors and replica counts.
- Nimbus rejects Uptime Kuma replica and topology-spread requests because the official chart Deployment template hard-codes one replica and exposes affinity only. It derives the PDB and affinity name selector from `nameOverride`.
- Nimbus rejects raw chart PDB settings when a Nimbus-owned PDB policy is configured for Prometheus, Grafana, Alertmanager, and Uptime Kuma.
- Redis tracker PDB now depends on the tracker Deployment.

## Chart evidence and limits

The official Uptime Kuma chart source is at [dirsigler/uptime-kuma-helm](https://github.com/dirsigler/uptime-kuma-helm). Its Deployment template currently sets `replicas: 1`, and its values expose affinity but not replica count or topology spread. The configured repository URL is the legacy GitHub Pages endpoint and `version` remains user-selectable; this test environment could not fetch/render the remote chart. Therefore there is no Helm render assertion in this report: the behavior is handled by rejecting unsupported typed fields, and resource-level Pulumi mock tests verify those failures and registered selectors. This does not validate arbitrary future upstream chart changes.

The distributed Loki workload set, default replica counts, and label selectors are mapped from the Grafana Loki chart's controller naming conventions. Remote chart rendering was unavailable in this environment, so chart-version-specific rendered manifests remain unverified.
