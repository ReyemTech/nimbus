# Disk Pressure Mitigation — Design

**Status:** Approved, awaiting implementation plan
**Date:** 2026-04-15
**Cluster context:** `reyemtech-iad-1` (Rackspace Spot, 4 worker nodes, 40Gi ephemeral storage per node, fixed)

## Problem

Nodes on the `reyemtech-iad-1` Rackspace Spot cluster regularly reach 83%+ ephemeral storage usage and trigger kubelet eviction. Contributing factors:

- ~20Gi of cumulative container image cache per node (≈50+ images)
- Per-pod ephemeral writes (Loki, container logs, application scratch space) without per-pod caps
- 40Gi root disk is fixed per Rackspace Spot server class — confirmed via `terraform-provider-spot` docs (no `disk_size` attribute on `spotnodepool`); kubelet GC thresholds are managed by Rackspace and not user-tunable

We cannot make the disks bigger and we cannot tune kubelet directly. Mitigation must be done at the workload and image-cache layer.

## Goals

- Cap unbounded per-pod ephemeral writes via per-namespace `LimitRange` defaults
- Reclaim image-cache disk on a schedule via per-node `crictl rmi --prune`
- Integrate via existing `nimbus` (Pulumi SDK) patterns so future clusters get coverage automatically
- Zero per-app Helm chart changes; zero ArgoCD apps for these foundational concerns

## Non-Goals

- Modifying individual application Helm charts to set their own resource limits (each app team owns this)
- Cluster autoscaler / node count changes
- Working around the Rackspace single-pool-per-cloudspace constraint
- Adding `ResourceQuota` at namespace level in v1 (deferred — see "Deferred")
- Adding LimitRange `max` enforcement in v1 (we set defaults only — see "Behavior")

## Architecture

Two pieces, both in `nimbus` (the SDK), consumed by `iac` with one config block:

```
nimbus/src/utils/ensure-namespace.ts             ← extended (existing chokepoint)
nimbus/src/platform/components/image-pruner.ts   ← new component
nimbus/src/platform/stack.ts                     ← wires image-pruner into createPlatformStack
nimbus/src/platform/interfaces.ts                ← adds NamespacePolicy + ImagePrunerConfig types
```

`nimbus/src/utils/ensure-namespace.ts` is the single chokepoint for all namespace creation in nimbus and iac (idempotent, in-process memoized). Extending it gives us universal coverage automatically. Helm-charts that auto-create their own namespaces bypass this chokepoint and require separate handling — see "Open Items."

`iac` changes are limited to a `namespacePolicies` override map and consuming the auto-enabled image pruner via existing `createPlatformStack` call.

## Cluster Scope

**`SYSTEM_NAMESPACES` (no LimitRange applied, even if explicitly requested):**

`kube-system`, `kube-public`, `kube-node-lease`, `calico-system`, `calico-apiserver`, `tigera-operator`, `projectsveltos`

**Operator-managed namespaces (DO get policy — they host user-shaped pods):**

`cnpg-system`, `mariadb-system`, `minio-operator`

**All other current namespaces get the default policy:**

`access`, `apps`, `argocd`, `cert-manager`, `data`, `default`, `external-dns`, `external-secrets`, `hivepipe`, `kimai`, `langfuse`, `n8n`, `observability`, `openclaw`, `solidtime`, `traefik`, `uptime-kuma`, `vault`

(Inventory taken 2026-04-15 from `kubectl --context reyemtech-iad-1 get ns`. Plan phase will re-verify and confirm 100% coverage.)

## Component Contracts

### `INamespacePolicy` and `DEFAULT_NAMESPACE_POLICY`

```ts
// nimbus/src/platform/interfaces.ts
export interface INamespacePolicy {
  readonly limitRange?: {
    readonly defaultRequest: { cpu?: string; memory?: string; ephemeralStorage?: string };
    readonly defaultLimit:   { cpu?: string; memory?: string; ephemeralStorage?: string };
  } | false;  // false = explicitly skip the LimitRange entirely
}

export const DEFAULT_NAMESPACE_POLICY: INamespacePolicy = {
  limitRange: {
    defaultRequest: { ephemeralStorage: "500Mi" },
    defaultLimit:   { ephemeralStorage: "2Gi" },
    // CPU/memory deliberately omitted: apps already declare these and silently
    // capping them would cause throttling/OOM with no warning.
  },
};
```

### Extended `ensureNamespace`

```ts
// nimbus/src/utils/ensure-namespace.ts
export function ensureNamespace(
  name: string,
  provider: k8s.Provider,
  opts: { policy?: INamespacePolicy | false } = {},
): k8s.core.v1.Namespace
```

| `policy` arg                            | Effect                                                              |
|-----------------------------------------|---------------------------------------------------------------------|
| omitted                                 | Apply `DEFAULT_NAMESPACE_POLICY` (universal coverage)               |
| `false`                                 | Namespace only, no LimitRange (escape hatch)                        |
| `{ limitRange: { ... } }`               | Use overrides (e.g., `apps` stop-gap override; reactive future tweaks) |
| `{ limitRange: false }`                 | Namespace + explicit no-LimitRange                                  |
| (any) when `name ∈ SYSTEM_NAMESPACES`   | Forced no-LimitRange regardless of caller                           |

Override merge semantics: **complete replacement, no merging.** If caller passes `policy: { limitRange: { defaultLimit: { ephemeralStorage: "10Gi" } } }` *without* a corresponding `defaultRequest`, the resulting LimitRange has only `defaultLimit` set and no `defaultRequest`. Callers MUST always pass both `defaultRequest` and `defaultLimit` when overriding (TypeScript enforces this — both fields are required on the `limitRange` interface). This avoids ambiguity around partial merges and makes overrides locally readable.

The LimitRange resource is created as a sibling resource named `default-limits` in the same namespace, with provider passed through.

### `IImagePrunerConfig` and `createImagePruner`

```ts
// nimbus/src/platform/components/image-pruner.ts
export interface IImagePrunerConfig {
  readonly enabled: boolean;
  readonly intervalSeconds?: number;   // default 21600 (6h)
  readonly image?: string;             // default resolved in plan phase
  readonly namespace?: string;         // default "kube-system"
}

export function createImagePruner(
  name: string,
  config: IImagePrunerConfig,
  provider: k8s.Provider,
): { daemonSet: k8s.apps.v1.DaemonSet } | null
```

Returns `null` when `enabled: false`. Returns the DaemonSet handle when enabled.

DaemonSet shape:

- **One pod per node** — selected via standard DaemonSet semantics
- **Privileged container** — required for crictl over the containerd socket
- **`hostPath` mount** — `/run/containerd/containerd.sock` → same path inside container
- **Container args** — sleep loop: `while true; do crictl rmi --prune; sleep $INTERVAL; done`
- **Resource limits on the pruner pod itself**:
  - `requests: { cpu: 50m, memory: 50Mi, ephemeralStorage: 50Mi }`
  - `limits: { cpu: 100m, memory: 100Mi, ephemeralStorage: 50Mi }`
- **Tolerations**: blanket `operator: Exists` `effect: NoSchedule` so it lands on every node including any future tainted ones
- **Labels**: `app: image-pruner` (used in operational verification commands)

### `createPlatformStack` integration

Add one optional field to the existing config interface:

```ts
imagePruner?: IImagePrunerConfig;  // default: { enabled: true, intervalSeconds: 21600 }
```

When `imagePruner` is omitted, the platform enables it by default (zero iac changes needed for adoption).

### `nimbus` singleton integration (for `namespacePolicies`)

Per-namespace overrides are NOT placed on `IPlatformStackConfig` because most namespaces are created by app-deployment code (`iac/src/apps/*.ts`, e.g., booklet, gta-events, reyemtech) — not by the platform stack. The override map must reach those `ensureNamespace()` calls too.

Solution: extend the existing `nimbus` singleton (already used for `notifications` at `nimbus/src/nimbus/index.ts`):

```ts
// nimbus/src/nimbus/interfaces.ts — extend INimbusConfig
export interface INimbusConfig {
  readonly notifications?: INotificationsConfig;  // existing
  readonly namespacePolicies?: Readonly<Record<string, INamespacePolicy | false>>;  // new
}
```

`ensureNamespace` reads from `nimbus.namespacePolicies?.[name]` as the override source on every call. Override resolution order inside `ensureNamespace`:

1. `opts.policy` (explicit per-call override) — highest precedence
2. `nimbus.namespacePolicies?.[name]` (singleton override)
3. `DEFAULT_NAMESPACE_POLICY` (fallback)

iac calls `nimbus.configure({ namespacePolicies: { apps: { ... } } })` once at the top of the stack file. Zero plumbing through function signatures.

## iac Consumption

Verified inventory of large-disk workloads (2026-04-15):

| Namespace        | Largest workload                | Storage approach              | Default OK? |
|------------------|---------------------------------|-------------------------------|-------------|
| `observability`  | Loki, Prometheus                | PVCs (75Gi `sata-large` / 20Gi `sata`) | ✓ |
| `data`           | Postgres / MariaDB / Neo4j / MinIO / Redis | All on PVCs (5–20Gi `ssd`/`sata`) | ✓ |
| `vault`          | Vault server                    | 5Gi PVC (`ssd`)               | ✓ |
| **`apps`**       | **Laravel-via-sail (booklet, gta-events, reyemtech)** | **Mostly ephemeral — `storage/logs/`, `storage/framework/{cache,sessions,views}`, `bootstrap/cache/`** | **No (stop-gap override)** |

The `apps` namespace hosts Laravel deployments built via `reyemtech/sail`. The current sail Helm chart does not set `LOG_CHANNEL=stderr` or default `resources` blocks, so Laravel pods write logs and file-cache to the ephemeral overlay unbounded. **Until `reyemtech/sail` resource hygiene ships (separate spec, see "Deferred"), the `apps` namespace gets a temporary override.**

Single addition in `iac/src/index.ts`, near the existing `nimbus.configure(...)` call:

```ts
// TEMPORARY — remove once reyemtech/sail ships LOG_CHANNEL=stderr default
// + explicit ephemeral-storage resource block. See: nimbus spec
// 2026-04-XX-sail-resource-hygiene-design.md (TBD).
nimbus.configure({
  namespacePolicies: {
    apps: {
      limitRange: {
        defaultRequest: { ephemeralStorage: "1Gi" },
        defaultLimit:   { ephemeralStorage: "5Gi" },
      },
    },
  },
});
```

This must run BEFORE any `ensureNamespace` call (i.e., before app deployments). The existing `nimbus.configure({ notifications: ... })` call in `iac/src/index.ts` already establishes this ordering — the `namespacePolicies` config can be merged into the same call or co-located.

All other namespaces use the default `2Gi` cap. Apps in `iac/src/apps/*.ts` that already call `ensureNamespace` pick up the default policy (or the singleton override if their namespace name matches a key) automatically — no per-app changes.

The `createPlatformStack` call itself is unchanged except optionally for `imagePruner` (which defaults to enabled).

**Reactive overrides** — if any pod outside `apps` is evicted post-rollout for `ephemeral local storage usage exceeds 2Gi`, the operational fix is a one-line addition to the `namespacePolicies` map, then `pulumi up`. The override mechanism is in place from v1.

## Behavior

### On `pulumi up` after this change

1. `createPlatformStack` runs first → creates `kube-system` DaemonSet for image pruner. Pods Ready within ~30s.
2. Each `ensureNamespace(...)` call (already scattered through nimbus + iac) co-creates a sibling `LimitRange/default-limits`.
3. Pulumi diff for an existing namespace = "1 to add: LimitRange/default-limits in `<ns>`," repeated ~18 times.
4. **No namespace updates. No pod restarts.** Existing pods unaffected.

### For new pods after rollout

| Pod's ephemeral-storage spec       | Result                                                                  |
|------------------------------------|-------------------------------------------------------------------------|
| Not set                            | Admission injects `request: 500Mi, limit: 2Gi` (or namespace override)  |
| Set explicitly                     | Pod's declared values win                                               |
| Set above any namespace `max`      | N/A in v1 — we are not setting `max`, only `default`                    |

### Image pruner runtime

Per-node prune loop runs `crictl rmi --prune` every 6h. `crictl rmi --prune` only removes images with **zero referencing containers** (running OR stopped). Safe by design — never removes an image in active use.

Effectiveness depends on container churn. Sticky nodes may see negligible reclaim; nodes with frequent rollouts/scaling see the most. This is a **safety valve for image-cache bloat over time**, not a daily liberation of GBs.

## Rollout Safety & Failure Modes

| Failure mode                                                        | Impact                                       | Mitigation                                                                                       |
|---------------------------------------------------------------------|----------------------------------------------|--------------------------------------------------------------------------------------------------|
| Pruner removes an in-use image                                      | Container crash on next start                | `crictl rmi --prune` is reference-counted by design; cannot remove in-use images                 |
| LimitRange chokes a legitimate workload                             | Pod evicted with `ephemeral local storage usage exceeds 2Gi` | Stage rollout (see below); inventoried large-disk workloads — all on PVCs, none rely on ephemeral; reactive override mechanism in place if eviction occurs |
| Pruner pod itself causes pressure                                   | Negligible (4 pods × 100Mi)                  | Bounded by pruner's own resource limits                                                          |
| Helm chart auto-creates namespace, bypassing `ensureNamespace`      | That namespace gets no LimitRange            | Plan-phase audit of all `k8s.helm.v3.Release` usages; either set `createNamespace: false` or add explicit LimitRange resource |

### Staged rollout (operational)

1. **Wave 1** — ship code with `imagePruner.enabled: true`, `ensureNamespace` extended, and the `apps` namespace stop-gap override. Run `pulumi preview`, confirm diff matches expectation (~18 LimitRanges + 1 DaemonSet, with `apps` showing the override values).
2. **Wave 2** — `pulumi up`. Watch `kubectl --context reyemtech-iad-1 get events -A -w` for 30 minutes for `Evicted` reasons. Watch pruner logs. Any eviction outside `apps` triggers a one-line override addition + immediate re-`pulumi up`.
3. **Wave 3 (24h later)** — confirm node disk usage trending down via `kubectl top nodes` + Grafana node-exporter dashboard. If yes, done. If no, adjust pruner interval.

### Rollback

| Component   | Rollback                                                | Time     | Pod impact |
|-------------|---------------------------------------------------------|----------|------------|
| LimitRange  | Delete the resource (defaults only matter at admission) | < 5s     | None       |
| Pruner      | `pulumi up` with `imagePruner: { enabled: false }`      | < 30s    | None       |

Both reversals are zero-downtime.

## Testing

### Unit tests (vitest, mock at Pulumi SDK boundary)

**`tests/unit/utils/ensure-namespace.test.ts`** (extended):
- Returns same instance on repeated calls (existing memoization invariant)
- No `policy` arg → creates Namespace + LimitRange with `DEFAULT_NAMESPACE_POLICY`
- `policy: false` → creates Namespace, no LimitRange
- `policy: { limitRange: { ... overrides } }` → LimitRange uses overrides
- Name in `SYSTEM_NAMESPACES` → no LimitRange even if `policy` provided

**`tests/unit/platform/components/image-pruner.test.ts`** (new):
- `enabled: false` → returns `null`
- Default config produces DaemonSet with: `privileged: true`, correct hostPath mount, correct sleep interval in args, blanket NoSchedule toleration, resource limits set
- Custom `intervalSeconds` reflected in container args
- Custom `namespace` lands DaemonSet in that namespace

**`tests/unit/platform/stack.test.ts`** (extended):
- `imagePruner` defaults to enabled when not passed
- `imagePruner: { enabled: false }` skips the component

**`tests/unit/utils/ensure-namespace.test.ts`** (additional cases for singleton):
- `nimbus.configure({ namespacePolicies: { foo: { ... } } })` is read by `ensureNamespace("foo", ...)` as override
- Explicit `opts.policy` overrides singleton override
- Singleton override of `false` skips the LimitRange

### Manual cluster verification (post-`pulumi up`)

1. `kubectl --context reyemtech-iad-1 get limitrange -A` → expect ~18 entries
2. `kubectl describe limitrange default-limits -n n8n` → confirm `ephemeral-storage 500Mi/2Gi`
3. `kubectl describe limitrange default-limits -n observability` → confirm default values (`500Mi/2Gi`)
4. `kubectl describe limitrange default-limits -n apps` → confirm stop-gap override (`1Gi/5Gi`)
5. `kubectl get daemonset -n kube-system image-pruner` → 4/4 ready
6. `kubectl logs -n kube-system -l app=image-pruner --tail=20` → see prune log lines
7. Exec into one pruner pod, run prune manually, confirm no errors against containerd socket
8. **24h later**: `kubectl top nodes` shows ephemeral storage stable or trending down vs pre-rollout baseline

## Deferred (Explicit v2 Items)

### `reyemtech/sail` resource hygiene (separate spec, parallel track)

The `apps` namespace stop-gap override (5Gi/1Gi) exists because `reyemtech/sail`'s Helm chart does not currently:

- Default `LOG_CHANNEL=stderr` (Laravel logs go to `storage/logs/laravel.log`, unbounded)
- Set a default `resources` block (no requests/limits unless caller provides)
- Default `CACHE_DRIVER=redis` / `SESSION_DRIVER=redis` when redis is plumbed
- Mount an `emptyDir` with `sizeLimit` at `storage/`

Each gap independently contributes to ephemeral bloat in Laravel pods. **A separate brainstorming + spec session for `reyemtech/sail` will follow this one.** Once sail-side fixes ship and propagate to all Laravel deployments, the `apps` namespace override should be deleted from `iac/src/index.ts` (verification: `kubectl describe limitrange default-limits -n apps` falls back to default `500Mi/2Gi`).

### ResourceQuota at namespace level

Audit on 2026-04-15 found zero ResourceQuotas cluster-wide. Skipping in v1 because:

- LimitRange `defaultLimit.ephemeralStorage: 2Gi` solves the actual disk-pressure root cause (unbounded pods). Per-pod cap × ~30 pods/node keeps max ephemeral usage well under 40Gi.
- ResourceQuota is a namespace-wide cap with very different blast radius — wrong number breaks legitimate scaling bursts.
- Picking defensible per-namespace caps requires usage data we don't have yet.

If v2 is needed, the design extension is straightforward: add `resourceQuota?: { ... } | false` to `INamespacePolicy` with the same opt-in/override pattern.

## Open Items for Plan Phase

These do not change the design but need resolution before code lands:

1. **Pruner image** — settle on a maintained image with `crictl` baked in. Candidates: `aanm/crictl`, building a tiny multi-arch image from `cri-tools` releases, piggybacking on an existing `kube-system` workload's image. Need multi-arch (cluster has amd64 nodes today, may add arm64).
2. **Helm-created namespace audit** — grep all `k8s.helm.v3.Release` calls in nimbus + iac for `createNamespace: true`. For each: either flip to `false` + add explicit `ensureNamespace` call, or add a sibling LimitRange resource.
3. **Final `SYSTEM_NAMESPACES` list verification** — confirm operator-managed namespaces (`cnpg-system`, `mariadb-system`, `minio-operator`) actually host pods that should be capped (they should — they run user databases — but verify).

## Files Changed (Summary)

| File                                                       | Change          | Approx LOC |
|------------------------------------------------------------|-----------------|-----------:|
| `nimbus/src/platform/interfaces.ts`                        | Add 2 types + constants + IImagePrunerConfig + imagePruner field | +30 |
| `nimbus/src/nimbus/interfaces.ts`                          | Extend INimbusConfig with namespacePolicies | +3 |
| `nimbus/src/nimbus/index.ts`                               | Add namespacePolicies getter on Nimbus class | +5 |
| `nimbus/src/utils/ensure-namespace.ts`                     | Extend signature, read singleton override, system-NS check | +50 |
| `nimbus/src/platform/components/image-pruner.ts`           | New file        | +90 |
| `nimbus/src/platform/components/index.ts`                  | Re-export       | +1 |
| `nimbus/src/platform/stack.ts`                             | Wire imagePruner + namespacePolicies | +20 |
| `nimbus/tests/unit/utils/ensure-namespace.test.ts`         | Extend          | +60 |
| `nimbus/tests/unit/platform/components/image-pruner.test.ts` | New             | +80 |
| `nimbus/tests/unit/platform/stack.test.ts`                 | Extend          | +30 |
| `iac/src/index.ts`                                         | Add stop-gap `apps` override | +12 |
| **Total**                                                  |                 | **~360** |
