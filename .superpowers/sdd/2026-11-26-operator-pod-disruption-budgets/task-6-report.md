# Task 6 Report: Eviction Integration and Documentation

## Status

Completed. Commit: `docs: document Nimbus PDB behavior and maintenance`.

## Changes

- Added `tests/integration/pod-disruption-budget-eviction.test.ts`, gated by `NIMBUS_PDB_TEST_CONTEXT`. It uses a generated namespace, temporary Deployments/PDBs, and `kubectl create --raw` against the Kubernetes Eviction API. It checks blocked singleton eviction, one allowed/second blocked eviction for a two-replica budget, and eviction without a budget. Cleanup deletes only the generated namespace in the selected context.
- Added `npm run test:integration:pdb`.
- Updated `README.md`, `docs/api-reference.md`, `docs/examples.md`, and `docs/examples/standalone.md` with defaults, voluntary eviction semantics, maintenance opt-out, singleton drain/scale-in impact, replica spreading, and database/operator ownership.
- Documented exclusions and limitations: CNPG only provides native enable/disable behavior; Neo4j's pinned chart path is unsupported; Jobs/CronJobs/DaemonSets are excluded; the Descheduler remains a CronJob; EKS add-on PDB fields are available only where the selected version-matched AWS schema supports a safe native field.
- Applied Prettier's requested changes to the two shared Task 1 files: `src/availability/pod-disruption-budget.ts` and `tests/unit/pod-disruption-budget.test.ts`.

## Verification

Commands and results from `/Users/mariomeyer/code/ReyemTech/infra/nimbus/.worktrees/operator-pdb-support`:

| Command | Result |
| --- | --- |
| `npm run test:integration:pdb` (without `NIMBUS_PDB_TEST_CONTEXT`) | Exit 0; `1 test skipped`, no cluster access attempted. |
| `npm run typecheck` | Exit 0. |
| `npm run lint` | Exit 0. |
| `npm test` | Exit 0; 51 files passed, integration file skipped; 1044 tests passed, 1 skipped. |
| `npm run format:check` | Exit 0; all matched TypeScript files formatted. |
| `git diff --check` | Exit 0. |

## Limitations

The live Kubernetes eviction assertions were not run because `NIMBUS_PDB_TEST_CONTEXT` was not configured. The test requires `kubectl`, a reachable context, and permission to create/delete a namespace and Deployments/PDBs, then create pod eviction subresources. The test only verifies voluntary eviction behavior; it does not test a node drain or infrastructure failure.

No production implementation defects were found during documentation review. Pre-existing untracked planning files were left untouched and excluded from the commit.

## Round 1 review fixes (base `974f341`)

- Added polling for PDB controller readiness: the test waits for matching `observedGeneration` and `disruptionsAllowed` of zero for the singleton and one for the pair before requesting eviction. After the first pair eviction, it waits until allowance is zero and that pod appears in `status.disruptedPods` before attempting the second eviction.
- Converted all Kubernetes invocations to asynchronous `execFile`, with `--request-timeout=10s` and a 15-second process timeout per call. Vitest timeout hooks and namespace cleanup can now run while a request is waiting; cleanup is asynchronous and bounded too.
- Corrected Neo4j documentation: it has no separate operator-controller availability settings, but `createCluster()` supports workload PDB and scheduling spread.
- Kept the two Task 1 Prettier-only changes (`src/availability/pod-disruption-budget.ts` and `tests/unit/pod-disruption-budget.test.ts`) because the Task 6 brief required a passing full `format:check`; they remain included in the first Task 6 commit.
- No package script change was needed; `test:integration:pdb` already targets this test file.

Exact commands and results from the review-fix pass:

| Command | Result |
| --- | --- |
| `npx prettier --write tests/integration/pod-disruption-budget-eviction.test.ts` | Exit 0; file unchanged. |
| `npm run test:integration:pdb` (without `NIMBUS_PDB_TEST_CONTEXT`) | Exit 0; 1 test skipped, no context access. |
| `npm run typecheck` | Exit 0. |
| `npm run lint` | Exit 0. |
| `npm test` | Exit 0; 51 files passed and integration file skipped; 1044 passed, 1 skipped. |
| `npm run format:check` | Exit 0; all matched TypeScript files formatted. |
| `git diff --check` | Exit 0. |

Live Kubernetes PDB readiness and eviction behavior remain unverified without a configured `NIMBUS_PDB_TEST_CONTEXT`.

## Round 2 review fix (base `679a683`)

Rollout status calls now use a 130-second Kubernetes request timeout and a 150-second process timeout, exceeding their explicit `--timeout=120s` while remaining bounded. Ordinary kubectl calls retain 10-second request and 15-second process timeouts.

Exact validation commands and results:

| Command | Result |
| --- | --- |
| `npx prettier --write tests/integration/pod-disruption-budget-eviction.test.ts` | Exit 0. |
| `npm run test:integration:pdb` (without `NIMBUS_PDB_TEST_CONTEXT`) | Exit 0; 1 test skipped, no cluster access attempted. |
| `npm run typecheck` | Exit 0. |
| `npm run lint` | Exit 0. |
| `npm test` | Exit 0; 51 files passed and integration file skipped; 1044 passed tests, 1 skipped. |
| `npm run format:check` | Exit 0; all matched TypeScript files formatted. |
| `git diff --check` | Exit 0. |

Live Kubernetes behavior remains unverified without `NIMBUS_PDB_TEST_CONTEXT`.
