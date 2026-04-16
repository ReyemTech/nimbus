# Disk Pressure Mitigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement cluster-side disk pressure mitigation in `nimbus` (SDK) + `iac` (consumer) via default `LimitRange` policy on every non-system namespace, plus a per-node image-cache pruner DaemonSet.

**Architecture:** Extend the existing `ensureNamespace` chokepoint in nimbus to co-create a sibling `LimitRange` resource with sensible ephemeral-storage defaults (500Mi request, 2Gi limit). Per-namespace overrides flow through the existing `nimbus` singleton (`nimbus.configure({ namespacePolicies })`) so they reach `ensureNamespace` calls in both nimbus internals AND iac app code. Add a new `createImagePruner` platform component — privileged DaemonSet running `crictl rmi --prune` on every node every 6h, image bootstrapped from `alpine:3.20` + cri-tools GitHub release at pod start. iac registers a single temporary `apps` namespace override (5Gi limit) for Laravel-via-sail pods, pending a separate sail-side resource hygiene spec.

**Tech Stack:** TypeScript, Pulumi, `@pulumi/kubernetes`, vitest (unit tests), alpine + crictl (runtime), kubectl (verification).

**Spec:** `nimbus/docs/superpowers/specs/2026-04-15-disk-pressure-mitigation-design.md`

---

## File Structure

**Created:**
- `nimbus/src/platform/components/image-pruner.ts` — privileged DaemonSet component
- `nimbus/tests/unit/ensure-namespace.test.ts` — namespace policy injection tests
- `nimbus/tests/unit/image-pruner.test.ts` — DaemonSet shape tests

**Modified:**
- `nimbus/src/platform/interfaces.ts` — add `INamespacePolicy`, `ILimitRangePolicy`, `DEFAULT_NAMESPACE_POLICY`, `SYSTEM_NAMESPACES`, `IImagePrunerConfig`; extend `IPlatformStackConfig` with `imagePruner` field
- `nimbus/src/nimbus/interfaces.ts` — extend `INimbusConfig` with `namespacePolicies` field
- `nimbus/src/nimbus/index.ts` — add `namespacePolicies` getter on `Nimbus` class
- `nimbus/src/utils/ensure-namespace.ts` — extend signature with `opts.policy`, read singleton override, system-NS exclusion, sibling LimitRange creation
- `nimbus/src/platform/components/index.ts` — re-export `createImagePruner`
- `nimbus/src/platform/stack.ts` — wire `createImagePruner` into `createPlatformStack` (no namespacePolicies plumbing — singleton handles that)
- `nimbus/tests/unit/platform-stack.test.ts` — add tests for image pruner wiring
- `iac/src/index.ts` — extend the existing `nimbus.configure({...})` call with stop-gap `apps` namespace override

**Tasks 1–3 are pre-implementation discovery (no commits).** Their results inform Tasks 4, 9, and 13.

---

## Task 1: Resolve pruner image choice

**Files:** None modified — discovery only.

- [ ] **Step 1: Verify alpine multi-arch availability**

Run: `docker manifest inspect alpine:3.20 2>&1 | head -30`
Expected: lists `linux/amd64` and `linux/arm64` platforms in the manifest list.

- [ ] **Step 2: Verify cri-tools GitHub release availability**

Run: `curl -sI https://github.com/kubernetes-sigs/cri-tools/releases/download/v1.30.0/crictl-v1.30.0-linux-amd64.tar.gz | head -1`
Expected: `HTTP/2 302` (redirects to release asset; binary exists). Repeat with `linux-arm64` to confirm both arches.

- [ ] **Step 3: Document decision**

Decision: use `alpine:3.20` as base + download `crictl v1.30.0` from `kubernetes-sigs/cri-tools` GitHub releases at pod start. Multi-arch handled via `$(uname -m)` in the script. Rationale: no third-party image dependency, ~5MB base, crictl binary ~10MB, cached after first start, easy version bump.

(No commit — discovery only.)

---

## Task 2: Audit Helm-created namespaces

**Files:** None modified — discovery only.

- [ ] **Step 1: Grep for `createNamespace: true` in nimbus + iac**

Run: `grep -rn "createNamespace.*true" /Users/mariomeyer/code/ReyemTech/nimbus/src /Users/mariomeyer/code/ReyemTech/iac/src 2>/dev/null`
Expected: a (possibly empty) list of `k8s.helm.v3.Release` invocations that auto-create their namespace.

- [ ] **Step 2: For each match, capture the namespace + decide a fix**

Create a scratch file `/tmp/helm-ns-audit.txt` with one row per match: `<file>:<line>  <namespace>  <pattern>`.

For each match:
- **Pattern A (preferred):** flip `createNamespace: true` → `false` and add `ensureNamespace("<ns>", provider)` before the `Release` call. Use unless flipping causes a Pulumi import conflict.
- **Pattern B (fallback):** keep the Release as-is and add an explicit `LimitRange` resource alongside it with the `DEFAULT_NAMESPACE_POLICY` values (see Task 13 for the snippet).

If grep returns zero matches, write `NO MATCHES` to the file and skip Task 13.

(No commit — discovery only.)

---

## Task 3: Verify operator namespace pod placement

**Files:** None modified — discovery only.

- [ ] **Step 1: List pods in operator-managed namespaces**

Run:
```
kubectl --context reyemtech-iad-1 -n cnpg-system get pods -o wide
echo ---
kubectl --context reyemtech-iad-1 -n mariadb-system get pods -o wide
echo ---
kubectl --context reyemtech-iad-1 -n minio-operator get pods -o wide
```
Expected: each namespace contains only operator pods (≤2 each), no user databases/buckets.

- [ ] **Step 2: Confirm user databases live in `data` namespace**

Run: `kubectl --context reyemtech-iad-1 -n data get pods | grep -E "(pgsql|mariadb-main|neo4j|minio-pool|redis-main)"`
Expected: lists pgsql-main-*, mariadb-main-*, neo4j-main-*, minio-pool-*, redis-main-* — confirming user DBs are in `data`, not in operator namespaces.

- [ ] **Step 3: Apply decision rule**

If both steps confirm operator-only pods → keep `cnpg-system`, `mariadb-system`, `minio-operator` OUT of `SYSTEM_NAMESPACES` (they get the default LimitRange).

If user pods are found in any operator namespace → ADD that namespace to `SYSTEM_NAMESPACES` in Task 4.

Document the outcome at the top of `/tmp/helm-ns-audit.txt` so Task 4 reflects it.

(No commit — discovery only.)

---

## Task 4: Add namespace policy types + constants

**Files:**
- Modify: `nimbus/src/platform/interfaces.ts`

- [ ] **Step 1: Append types and constants to interfaces.ts**

Append the following to `nimbus/src/platform/interfaces.ts` (preserve all existing content):

```ts
/**
 * Per-Container LimitRange defaults applied when a pod does not declare its own.
 * Both fields are required to avoid partial-merge ambiguity at admission time.
 */
export interface ILimitRangePolicy {
  readonly defaultRequest: {
    readonly cpu?: string;
    readonly memory?: string;
    readonly ephemeralStorage?: string;
  };
  readonly defaultLimit: {
    readonly cpu?: string;
    readonly memory?: string;
    readonly ephemeralStorage?: string;
  };
}

/**
 * Namespace-scoped policy attached at namespace creation time.
 * Pass `false` (whole policy) or `{ limitRange: false }` to opt out.
 */
export interface INamespacePolicy {
  readonly limitRange?: ILimitRangePolicy | false;
}

/**
 * Default policy applied to every namespace created via ensureNamespace
 * unless explicitly overridden.
 *
 * CPU/memory deliberately omitted: apps already declare these, and silently
 * capping them would cause throttling/OOM with no warning.
 */
export const DEFAULT_NAMESPACE_POLICY: INamespacePolicy = {
  limitRange: {
    defaultRequest: { ephemeralStorage: "500Mi" },
    defaultLimit: { ephemeralStorage: "2Gi" },
  },
};

/**
 * Namespaces that NEVER get a LimitRange, even if a policy is explicitly passed.
 * These are managed by cluster operators and should not be subject to user-tier
 * resource policy.
 */
export const SYSTEM_NAMESPACES: ReadonlySet<string> = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "calico-system",
  "calico-apiserver",
  "tigera-operator",
  "projectsveltos",
]);
```

If Task 3 found user pods in operator namespaces, add those names to `SYSTEM_NAMESPACES` here.

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/mariomeyer/code/ReyemTech/nimbus && \
  git add src/platform/interfaces.ts && \
  git commit -m "feat(platform): add INamespacePolicy types and DEFAULT_NAMESPACE_POLICY"
```

---

## Task 4b: Extend `INimbusConfig` with `namespacePolicies`

**Files:**
- Modify: `nimbus/src/nimbus/interfaces.ts`
- Modify: `nimbus/src/nimbus/index.ts`

- [ ] **Step 1: Extend `INimbusConfig`**

In `nimbus/src/nimbus/interfaces.ts`, add an import at the top:

```ts
import type { INamespacePolicy } from "../platform/interfaces";
```

Modify the `INimbusConfig` interface (currently has only `notifications`):

```ts
/** Top-level nimbus configuration. */
export interface INimbusConfig {
  readonly notifications?: INotificationsConfig;
  /** Per-namespace LimitRange overrides, keyed by namespace name. Read by ensureNamespace. */
  readonly namespacePolicies?: Readonly<Record<string, INamespacePolicy | false>>;
}
```

- [ ] **Step 2: Add `namespacePolicies` getter on `Nimbus` class**

In `nimbus/src/nimbus/index.ts`, find the existing `notifications` getter on the `Nimbus` class. Below it, add:

```ts
  /** Get per-namespace policy overrides (read by ensureNamespace). */
  get namespacePolicies(): Readonly<Record<string, import("../platform/interfaces").INamespacePolicy | false>> | undefined {
    return this.config.namespacePolicies;
  }
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/mariomeyer/code/ReyemTech/nimbus && \
  git add src/nimbus/interfaces.ts src/nimbus/index.ts && \
  git commit -m "feat(nimbus): add namespacePolicies to INimbusConfig singleton"
```

---

## Task 5: Write failing tests for `ensureNamespace` policy injection

**Files:**
- Create: `nimbus/tests/unit/ensure-namespace.test.ts`

- [ ] **Step 1: Create the test file**

Create `nimbus/tests/unit/ensure-namespace.test.ts` with this content:

```ts
/**
 * Unit tests for ensureNamespace policy injection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockProvider = (): any => ({});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdNamespaces: Array<{ name: string; args: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdLimitRanges: Array<{ name: string; args: any }>;

vi.mock("@pulumi/kubernetes", () => {
  const mockNamespace = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdNamespaces.push({ name, args });
    }
  };
  const mockLimitRange = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdLimitRanges.push({ name, args });
    }
  };
  return {
    core: { v1: { Namespace: mockNamespace, LimitRange: mockLimitRange } },
  };
});

beforeEach(() => {
  createdNamespaces = [];
  createdLimitRanges = [];
  vi.resetModules();
});

describe("ensureNamespace", () => {
  it("creates Namespace + default LimitRange when no policy passed", async () => {
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace");
    ensureNamespace("test-ns", mockProvider());
    expect(createdNamespaces).toHaveLength(1);
    expect(createdNamespaces[0]?.args.metadata.name).toBe("test-ns");
    expect(createdLimitRanges).toHaveLength(1);
    expect(createdLimitRanges[0]?.args.metadata.namespace).toBe("test-ns");
    expect(createdLimitRanges[0]?.args.metadata.name).toBe("default-limits");
    const limit = createdLimitRanges[0]?.args.spec.limits[0];
    expect(limit.type).toBe("Container");
    expect(limit.defaultRequest.ephemeralStorage).toBe("500Mi");
    expect(limit.default.ephemeralStorage).toBe("2Gi");
  });

  it("memoizes namespace creation", async () => {
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace");
    const provider = mockProvider();
    const ns1 = ensureNamespace("memo-ns", provider);
    const ns2 = ensureNamespace("memo-ns", provider);
    expect(ns1).toBe(ns2);
    expect(createdNamespaces).toHaveLength(1);
  });

  it("creates Namespace only (no LimitRange) when policy is false", async () => {
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace");
    ensureNamespace("opt-out-ns", mockProvider(), { policy: false });
    expect(createdNamespaces).toHaveLength(1);
    expect(createdLimitRanges).toHaveLength(0);
  });

  it("creates Namespace only when policy.limitRange is false", async () => {
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace");
    ensureNamespace("opt-out-lr", mockProvider(), {
      policy: { limitRange: false },
    });
    expect(createdNamespaces).toHaveLength(1);
    expect(createdLimitRanges).toHaveLength(0);
  });

  it("uses override values when policy.limitRange is provided", async () => {
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace");
    ensureNamespace("custom-ns", mockProvider(), {
      policy: {
        limitRange: {
          defaultRequest: { ephemeralStorage: "1Gi" },
          defaultLimit: { ephemeralStorage: "5Gi" },
        },
      },
    });
    const limit = createdLimitRanges[0]?.args.spec.limits[0];
    expect(limit.defaultRequest.ephemeralStorage).toBe("1Gi");
    expect(limit.default.ephemeralStorage).toBe("5Gi");
  });

  it("does NOT create LimitRange for SYSTEM_NAMESPACES even when policy passed", async () => {
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace");
    ensureNamespace("kube-system", mockProvider(), {
      policy: {
        limitRange: {
          defaultRequest: { ephemeralStorage: "1Gi" },
          defaultLimit: { ephemeralStorage: "5Gi" },
        },
      },
    });
    expect(createdNamespaces).toHaveLength(1);
    expect(createdLimitRanges).toHaveLength(0);
  });

  it("reads override from nimbus singleton when no opts.policy passed", async () => {
    const { nimbus } = await import("../../src/nimbus");
    nimbus.configure({
      namespacePolicies: {
        "from-singleton": {
          limitRange: {
            defaultRequest: { ephemeralStorage: "750Mi" },
            defaultLimit: { ephemeralStorage: "3Gi" },
          },
        },
      },
    });
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace");
    ensureNamespace("from-singleton", mockProvider());
    const limit = createdLimitRanges[0]?.args.spec.limits[0];
    expect(limit.defaultRequest.ephemeralStorage).toBe("750Mi");
    expect(limit.default.ephemeralStorage).toBe("3Gi");
  });

  it("opts.policy takes precedence over singleton override", async () => {
    const { nimbus } = await import("../../src/nimbus");
    nimbus.configure({
      namespacePolicies: {
        "precedence-test": {
          limitRange: {
            defaultRequest: { ephemeralStorage: "1Gi" },
            defaultLimit: { ephemeralStorage: "5Gi" },
          },
        },
      },
    });
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace");
    ensureNamespace("precedence-test", mockProvider(), {
      policy: {
        limitRange: {
          defaultRequest: { ephemeralStorage: "2Gi" },
          defaultLimit: { ephemeralStorage: "10Gi" },
        },
      },
    });
    const limit = createdLimitRanges[0]?.args.spec.limits[0];
    expect(limit.defaultRequest.ephemeralStorage).toBe("2Gi");
    expect(limit.default.ephemeralStorage).toBe("10Gi");
  });

  it("singleton override of false skips the LimitRange", async () => {
    const { nimbus } = await import("../../src/nimbus");
    nimbus.configure({
      namespacePolicies: {
        "skip-from-singleton": false,
      },
    });
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace");
    ensureNamespace("skip-from-singleton", mockProvider());
    expect(createdNamespaces).toHaveLength(1);
    expect(createdLimitRanges).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npx vitest run tests/unit/ensure-namespace.test.ts`
Expected: FAIL — most tests fail because current `ensureNamespace` does not accept `opts` and does not create a `LimitRange`. Memoization test should pass.

- [ ] **Step 3: Commit failing tests**

```bash
cd /Users/mariomeyer/code/ReyemTech/nimbus && \
  git add tests/unit/ensure-namespace.test.ts && \
  git commit -m "test(utils): add ensureNamespace policy injection tests (failing)"
```

---

## Task 6: Implement `ensureNamespace` policy injection

**Files:**
- Modify: `nimbus/src/utils/ensure-namespace.ts`

- [ ] **Step 1: Replace the entire file content**

Overwrite `nimbus/src/utils/ensure-namespace.ts` with:

```ts
import * as k8s from "@pulumi/kubernetes";
import {
  type INamespacePolicy,
  DEFAULT_NAMESPACE_POLICY,
  SYSTEM_NAMESPACES,
} from "../platform/interfaces";
import { nimbus } from "../nimbus";

const createdNamespaces = new Map<string, k8s.core.v1.Namespace>();

export interface IEnsureNamespaceOpts {
  /**
   * Per-namespace policy. Omit to fall back to (in order):
   *   1. nimbus.namespacePolicies?.[name] singleton override
   *   2. DEFAULT_NAMESPACE_POLICY
   *
   * Pass `false` (or `{ limitRange: false }`) to skip the LimitRange entirely.
   */
  readonly policy?: INamespacePolicy | false;
}

/**
 * Ensure a Kubernetes namespace exists. Creates it if it doesn't.
 * Idempotent — returns the same Namespace resource for repeated calls.
 *
 * Side effect: co-creates a sibling `LimitRange/default-limits` in the same
 * namespace. Resolution order for the policy:
 *   1. `opts.policy` (explicit per-call)
 *   2. `nimbus.namespacePolicies?.[name]` (singleton override)
 *   3. `DEFAULT_NAMESPACE_POLICY` (fallback)
 *
 * SYSTEM_NAMESPACES never get a LimitRange, regardless of policy.
 */
export function ensureNamespace(
  name: string,
  provider: k8s.Provider,
  opts: IEnsureNamespaceOpts = {}
): k8s.core.v1.Namespace {
  const existing = createdNamespaces.get(name);
  if (existing) {
    return existing;
  }
  const ns = new k8s.core.v1.Namespace(
    `ensure-ns-${name}`,
    { metadata: { name } },
    { provider }
  );
  createdNamespaces.set(name, ns);

  if (SYSTEM_NAMESPACES.has(name)) {
    return ns;
  }

  // Resolve policy: explicit opts > singleton override > default
  let policy: INamespacePolicy | false;
  if (opts.policy === false) {
    policy = false;
  } else if (opts.policy !== undefined) {
    policy = opts.policy;
  } else {
    const singletonOverride = nimbus.namespacePolicies?.[name];
    if (singletonOverride === false) {
      policy = false;
    } else if (singletonOverride !== undefined) {
      policy = singletonOverride;
    } else {
      policy = DEFAULT_NAMESPACE_POLICY;
    }
  }

  if (policy === false || policy.limitRange === false || policy.limitRange === undefined) {
    return ns;
  }

  new k8s.core.v1.LimitRange(
    `ensure-ns-${name}-default-limits`,
    {
      metadata: { name: "default-limits", namespace: name },
      spec: {
        limits: [
          {
            type: "Container",
            defaultRequest: policy.limitRange.defaultRequest,
            default: policy.limitRange.defaultLimit,
          },
        ],
      },
    },
    { provider, dependsOn: [ns] }
  );

  return ns;
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npx vitest run tests/unit/ensure-namespace.test.ts`
Expected: PASS — all 6 tests pass.

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/mariomeyer/code/ReyemTech/nimbus && \
  git add src/utils/ensure-namespace.ts && \
  git commit -m "feat(utils): inject default LimitRange via ensureNamespace"
```

---

## Task 7: Add `IImagePrunerConfig` + extend `IPlatformStackConfig`

**Files:**
- Modify: `nimbus/src/platform/interfaces.ts`

- [ ] **Step 1: Append `IImagePrunerConfig` interface**

Append to `nimbus/src/platform/interfaces.ts`:

```ts
/** Image-cache pruner DaemonSet configuration. */
export interface IImagePrunerConfig {
  /** Enable the pruner DaemonSet. Default: true. */
  readonly enabled?: boolean;
  /** Prune interval in seconds. Default: 21600 (6h). */
  readonly intervalSeconds?: number;
  /** Base image. Default: "alpine:3.20" (crictl downloaded at pod start). */
  readonly image?: string;
  /** Namespace for the DaemonSet. Default: "kube-system". */
  readonly namespace?: string;
}
```

- [ ] **Step 2: Add `imagePruner` field to `IPlatformStackConfig`**

Inside the existing `IPlatformStackConfig` interface, immediately after the `descheduler` field, add:

```ts
  /** Per-node image cache pruner. Default: { enabled: true, intervalSeconds: 21600 }. */
  readonly imagePruner?: IImagePrunerConfig;
```

Note: per-namespace overrides (`namespacePolicies`) are NOT on `IPlatformStackConfig` — they live on the `nimbus` singleton (already added in Task 4b) so they reach `ensureNamespace` calls in app code too.

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/mariomeyer/code/ReyemTech/nimbus && \
  git add src/platform/interfaces.ts && \
  git commit -m "feat(platform): add IImagePrunerConfig + namespacePolicies to IPlatformStackConfig"
```

---

## Task 8: Write failing tests for `createImagePruner`

**Files:**
- Create: `nimbus/tests/unit/image-pruner.test.ts`

- [ ] **Step 1: Create the test file**

Create `nimbus/tests/unit/image-pruner.test.ts` with:

```ts
/**
 * Unit tests for createImagePruner DaemonSet.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockProvider = (): any => ({});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdDaemonSets: Array<{ name: string; args: any }>;

vi.mock("@pulumi/kubernetes", () => {
  const mockDaemonSet = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdDaemonSets.push({ name, args });
    }
  };
  return {
    apps: { v1: { DaemonSet: mockDaemonSet } },
  };
});

beforeEach(() => {
  createdDaemonSets = [];
  vi.resetModules();
});

describe("createImagePruner", () => {
  it("returns null when enabled: false", async () => {
    const { createImagePruner } = await import(
      "../../src/platform/components/image-pruner"
    );
    const result = createImagePruner("test", { enabled: false }, mockProvider());
    expect(result).toBeNull();
    expect(createdDaemonSets).toHaveLength(0);
  });

  it("creates DaemonSet with privileged container, hostPath socket, default interval", async () => {
    const { createImagePruner } = await import(
      "../../src/platform/components/image-pruner"
    );
    const result = createImagePruner("test", {}, mockProvider());
    expect(result).not.toBeNull();
    expect(createdDaemonSets).toHaveLength(1);
    const ds = createdDaemonSets[0]!.args;
    expect(ds.metadata.namespace).toBe("kube-system");

    const container = ds.spec.template.spec.containers[0];
    expect(container.securityContext.privileged).toBe(true);
    expect(container.args.join(" ")).toContain("21600");

    const volumeMount = container.volumeMounts.find(
      (v: { name: string }) => v.name === "containerd-sock"
    );
    expect(volumeMount.mountPath).toBe("/run/containerd/containerd.sock");

    const hostPath = ds.spec.template.spec.volumes.find(
      (v: { name: string }) => v.name === "containerd-sock"
    );
    expect(hostPath.hostPath.path).toBe("/run/containerd/containerd.sock");

    const resources = container.resources;
    expect(resources.requests.cpu).toBe("50m");
    expect(resources.limits.memory).toBe("100Mi");
    expect(resources.limits["ephemeral-storage"]).toBe("50Mi");

    const tolerations = ds.spec.template.spec.tolerations;
    expect(tolerations).toContainEqual({ operator: "Exists", effect: "NoSchedule" });
  });

  it("uses custom intervalSeconds when provided", async () => {
    const { createImagePruner } = await import(
      "../../src/platform/components/image-pruner"
    );
    createImagePruner("test", { intervalSeconds: 3600 }, mockProvider());
    const args = createdDaemonSets[0]!.args.spec.template.spec.containers[0].args.join(" ");
    expect(args).toContain("3600");
    expect(args).not.toContain("21600");
  });

  it("uses custom namespace when provided", async () => {
    const { createImagePruner } = await import(
      "../../src/platform/components/image-pruner"
    );
    createImagePruner("test", { namespace: "infra" }, mockProvider());
    expect(createdDaemonSets[0]!.args.metadata.namespace).toBe("infra");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npx vitest run tests/unit/image-pruner.test.ts`
Expected: FAIL — module `../../src/platform/components/image-pruner` does not exist yet.

- [ ] **Step 3: Commit failing tests**

```bash
cd /Users/mariomeyer/code/ReyemTech/nimbus && \
  git add tests/unit/image-pruner.test.ts && \
  git commit -m "test(platform): add createImagePruner tests (failing)"
```

---

## Task 9: Implement `createImagePruner`

**Files:**
- Create: `nimbus/src/platform/components/image-pruner.ts`

- [ ] **Step 1: Create the component file**

Create `nimbus/src/platform/components/image-pruner.ts` with:

```ts
/**
 * Image-cache pruner DaemonSet.
 *
 * Runs `crictl rmi --prune` on each node every N seconds to reclaim
 * disk space from unused container images. Safe by design — crictl
 * never removes images with active references.
 *
 * Image strategy: alpine base + crictl downloaded from kubernetes-sigs/cri-tools
 * GitHub releases at pod start. Cached in container fs after first start.
 * Multi-arch supported via $(uname -m) → amd64/arm64 mapping.
 *
 * @module platform/components/image-pruner
 */

import * as k8s from "@pulumi/kubernetes";
import type { IImagePrunerConfig } from "../interfaces";

const CRICTL_VERSION = "v1.30.0";
const DEFAULT_IMAGE = "alpine:3.20";
const DEFAULT_INTERVAL = 21600; // 6 hours
const DEFAULT_NAMESPACE = "kube-system";

export function createImagePruner(
  name: string,
  config: IImagePrunerConfig,
  provider: k8s.Provider
): k8s.apps.v1.DaemonSet | null {
  if (config.enabled === false) {
    return null;
  }

  const interval = config.intervalSeconds ?? DEFAULT_INTERVAL;
  const image = config.image ?? DEFAULT_IMAGE;
  const namespace = config.namespace ?? DEFAULT_NAMESPACE;

  const script = `set -e
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH=amd64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "unsupported arch: $ARCH"; exit 1 ;;
esac
if [ ! -x /usr/local/bin/crictl ]; then
  apk add --no-cache curl tar
  curl -fsSL https://github.com/kubernetes-sigs/cri-tools/releases/download/${CRICTL_VERSION}/crictl-${CRICTL_VERSION}-linux-\${ARCH}.tar.gz \\
    | tar -xz -C /usr/local/bin
fi
while true; do
  echo "[$(date -Iseconds)] pruning unused images..."
  crictl --runtime-endpoint unix:///run/containerd/containerd.sock rmi --prune || echo "prune failed (will retry)"
  sleep ${interval}
done`;

  return new k8s.apps.v1.DaemonSet(
    `${name}-image-pruner`,
    {
      metadata: {
        name: "image-pruner",
        namespace,
        labels: { app: "image-pruner" },
      },
      spec: {
        selector: { matchLabels: { app: "image-pruner" } },
        template: {
          metadata: { labels: { app: "image-pruner" } },
          spec: {
            tolerations: [{ operator: "Exists", effect: "NoSchedule" }],
            hostPID: false,
            containers: [
              {
                name: "pruner",
                image,
                command: ["/bin/sh", "-c"],
                args: [script],
                securityContext: {
                  privileged: true,
                  runAsUser: 0,
                },
                resources: {
                  requests: {
                    cpu: "50m",
                    memory: "50Mi",
                    "ephemeral-storage": "50Mi",
                  },
                  limits: {
                    cpu: "100m",
                    memory: "100Mi",
                    "ephemeral-storage": "50Mi",
                  },
                },
                volumeMounts: [
                  {
                    name: "containerd-sock",
                    mountPath: "/run/containerd/containerd.sock",
                  },
                ],
              },
            ],
            volumes: [
              {
                name: "containerd-sock",
                hostPath: {
                  path: "/run/containerd/containerd.sock",
                  type: "Socket",
                },
              },
            ],
          },
        },
      },
    },
    { provider }
  );
}
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npx vitest run tests/unit/image-pruner.test.ts`
Expected: PASS — all 4 tests pass.

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/mariomeyer/code/ReyemTech/nimbus && \
  git add src/platform/components/image-pruner.ts && \
  git commit -m "feat(platform): add createImagePruner DaemonSet component"
```

---

## Task 10: Re-export `createImagePruner` from components index

**Files:**
- Modify: `nimbus/src/platform/components/index.ts`

- [ ] **Step 1: Append the export**

Append to `nimbus/src/platform/components/index.ts`:

```ts
export { createImagePruner } from "./image-pruner";
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npm run typecheck`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/mariomeyer/code/ReyemTech/nimbus && \
  git add src/platform/components/index.ts && \
  git commit -m "feat(platform): re-export createImagePruner"
```

---

## Task 11: Wire `createImagePruner` + `namespacePolicies` into `createPlatformStack`

**Files:**
- Modify: `nimbus/src/platform/stack.ts`

- [ ] **Step 1: Update components import**

In `nimbus/src/platform/stack.ts`, find the existing components import block:

```ts
import {
  deployTraefik,
  deployCertManager,
  deployExternalDns,
  deployArgocd,
  deployVault,
  deployExternalSecrets,
  deployOAuth2Proxy,
  deployDescheduler,
} from "./components";
```

Replace with:

```ts
import {
  deployTraefik,
  deployCertManager,
  deployExternalDns,
  deployArgocd,
  deployVault,
  deployExternalSecrets,
  deployOAuth2Proxy,
  deployDescheduler,
  createImagePruner,
} from "./components";
```

- [ ] **Step 2: Add image pruner deployment in `deployToCluster`**

Find the descheduler deployment block in the `deployToCluster` function (search for `if (config.descheduler?.enabled !== false)`). Immediately after that block's closing `}`, add:

```ts
  // Image pruner (per-node container cache cleanup) — enabled by default
  if (config.imagePruner?.enabled !== false) {
    createImagePruner(name, config.imagePruner ?? {}, provider);
  }
```

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npm run typecheck`
Expected: 0 errors.

(No additional `namespacePolicies` plumbing here — `ensureNamespace` reads the singleton override directly.)

- [ ] **Step 4: Commit**

```bash
cd /Users/mariomeyer/code/ReyemTech/nimbus && \
  git add src/platform/stack.ts && \
  git commit -m "feat(platform): wire imagePruner into createPlatformStack"
```

---

## Task 12: Add `platform-stack.test.ts` tests for new wiring

**Files:**
- Modify: `nimbus/tests/unit/platform-stack.test.ts`

- [ ] **Step 1: Inspect existing mock and tracking arrays**

Read `nimbus/tests/unit/platform-stack.test.ts` (lines 1–150). Note the existing pattern for `vi.mock("@pulumi/kubernetes", ...)` and the `createdReleases` / `createdCustomResources` tracking arrays.

- [ ] **Step 2: Add `createdDaemonSets` tracking + DaemonSet mock**

Near the top of the file (where other tracking arrays are declared), add:

```ts
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdDaemonSets: Array<{ name: string; args: any }>;
```

Inside the `vi.mock("@pulumi/kubernetes", ...)` factory, add a DaemonSet mock class:

```ts
const mockDaemonSet = class {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(name: string, args: any, _opts?: any) {
    createdDaemonSets.push({ name, args });
  }
};
```

In the same mock factory's return object, add (or extend) the `apps` namespace:

```ts
return {
  // ...existing exports...
  apps: { v1: { DaemonSet: mockDaemonSet } },
};
```

(If `apps.v1.DaemonSet` is already exposed, only the tracking array + push call need adding.)

In the `beforeEach` block, add:

```ts
createdDaemonSets = [];
```

- [ ] **Step 3: Add tests at the end of the existing `describe` block**

Append two new `it` blocks:

```ts
  it("creates image pruner DaemonSet by default", async () => {
    const { createPlatformStack } = await import("../../src/platform/stack");
    createPlatformStack("test", { cluster: mockCluster, domain: "example.com" });
    expect(
      createdDaemonSets.some((d) => d.args.metadata.name === "image-pruner")
    ).toBe(true);
  });

  it("skips image pruner when imagePruner.enabled is false", async () => {
    const { createPlatformStack } = await import("../../src/platform/stack");
    createPlatformStack("test", {
      cluster: mockCluster,
      domain: "example.com",
      imagePruner: { enabled: false },
    });
    expect(
      createdDaemonSets.some((d) => d.args.metadata.name === "image-pruner")
    ).toBe(false);
  });
```

(`mockCluster` should already be defined in the existing test file. Reuse it.)

- [ ] **Step 4: Run platform-stack tests**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npx vitest run tests/unit/platform-stack.test.ts`
Expected: PASS — all existing tests + the 2 new ones.

- [ ] **Step 5: Commit**

```bash
cd /Users/mariomeyer/code/ReyemTech/nimbus && \
  git add tests/unit/platform-stack.test.ts && \
  git commit -m "test(platform): add imagePruner wiring tests"
```

---

## Task 13: Fix Helm-created namespaces from Task 2 audit

**Files:** Per-finding from Task 2 (`/tmp/helm-ns-audit.txt`).

Skip this task entirely if Task 2's audit returned `NO MATCHES`.

- [ ] **Step 1: Apply Pattern A to each Pattern-A entry**

For each row in the audit:
1. Open the file at the indicated line.
2. Change `createNamespace: true` → `createNamespace: false` in the `k8s.helm.v3.Release` args.
3. Add `ensureNamespace("<ns>", provider);` immediately before the `new k8s.helm.v3.Release(...)` call.
4. If `ensureNamespace` is not already imported in the file, add: `import { ensureNamespace } from "<relative-path-to>/utils/ensure-namespace";`

Example diff:
```ts
// Before
new k8s.helm.v3.Release("foo", {
  // ...
  namespace: "bar",
  createNamespace: true,
}, { provider });

// After
ensureNamespace("bar", provider);
new k8s.helm.v3.Release("foo", {
  // ...
  namespace: "bar",
  createNamespace: false,
}, { provider });
```

- [ ] **Step 2: Apply Pattern B to each Pattern-B entry (only if Step 1 caused an import conflict)**

For each fallback entry, add an explicit `LimitRange` next to the existing Release. Do NOT flip `createNamespace`:

```ts
new k8s.core.v1.LimitRange(`<ns>-default-limits`, {
  metadata: { name: "default-limits", namespace: "<ns>" },
  spec: {
    limits: [
      {
        type: "Container",
        defaultRequest: { ephemeralStorage: "500Mi" },
        default: { ephemeralStorage: "2Gi" },
      },
    ],
  },
}, { provider });
```

- [ ] **Step 3: Run typecheck + full test suite**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npm run typecheck && npm test`
Expected: 0 errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
cd /Users/mariomeyer/code/ReyemTech/nimbus && \
  git add -A && \
  git commit -m "fix(platform): route all namespaces through ensureNamespace for policy coverage"
```

---

## Task 14: Run full nimbus quality gates

**Files:** None modified (verification only — unless format auto-fixes files).

- [ ] **Step 1: Run lint**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npm run lint`
Expected: 0 errors.

- [ ] **Step 2: Run format check**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npm run format:check`
Expected: 0 errors. If failures: run `npm run format`, then `git add -A && git commit -m "style: prettier autofix"`.

- [ ] **Step 3: Run typecheck**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npm run typecheck`
Expected: 0 errors.

- [ ] **Step 4: Run full test suite with coverage**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npm run test:coverage`
Expected: all tests pass, coverage thresholds (80%) met. Coverage exclusions in `vitest.config.ts` already exclude index barrels and aws/azure implementations.

- [ ] **Step 5: Run build**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && npm run build`
Expected: builds clean to `dist/esm/` and `dist/cjs/`.

(No commit unless format fixed files.)

---

## Task 15: Release nimbus + bump iac dependency

**Files:**
- Modify: `iac/package.json` (after nimbus release lands)

The iac repo depends on `@reyemtech/nimbus: ^2.3.1` (semver, published). To consume the changes from Tasks 1–14, nimbus must be released and iac's dependency bumped.

- [ ] **Step 1: Push nimbus to main and let semantic-release publish**

Run: `cd /Users/mariomeyer/code/ReyemTech/nimbus && git push origin main`
Expected: GitHub Actions runs lint → format:check → typecheck → test:coverage → build → semantic-release. Watch the Actions tab; verify a new minor version (e.g., `2.11.0`) is tagged and published to npm.

If the release fails, debug per CI logs before proceeding.

- [ ] **Step 2: Bump nimbus version in iac**

In `iac/package.json`, find:
```json
"@reyemtech/nimbus": "^2.3.1",
```

Replace `2.3.1` with the version freshly published in Step 1 (e.g., `2.11.0`).

- [ ] **Step 3: Install + verify resolution**

Run: `cd /Users/mariomeyer/code/ReyemTech/iac && npm install`
Expected: `package-lock.json` updated to the new nimbus version.

Run: `cd /Users/mariomeyer/code/ReyemTech/iac && grep '"@reyemtech/nimbus"' node_modules/@reyemtech/nimbus/package.json`
Expected: shows the freshly-released version number.

- [ ] **Step 4: Commit iac dependency bump**

```bash
cd /Users/mariomeyer/code/ReyemTech/iac && \
  git add package.json package-lock.json && \
  git commit -m "chore: bump @reyemtech/nimbus to <new-version>"
```

(Replace `<new-version>` with the actual version.)

---

## Task 16: Add iac stop-gap `apps` namespace override

**Files:**
- Modify: `iac/src/index.ts`

- [ ] **Step 1: Extend the existing `nimbus.configure({...})` call**

In `iac/src/index.ts`, locate the existing `nimbus.configure({...})` call (around line 162, currently passes `notifications: { ... }`).

Add a `namespacePolicies` field to the same config object so the singleton is configured in one place:

```ts
nimbus.configure({
  notifications: {
    email: { transport: emailTransport, to: "mario@reyem.tech" },
  },
  // TEMPORARY — remove once reyemtech/sail ships LOG_CHANNEL=stderr default
  // + explicit ephemeral-storage resource block. See: nimbus/docs/superpowers/specs/
  // 2026-04-XX-sail-resource-hygiene-design.md (TBD).
  namespacePolicies: {
    apps: {
      limitRange: {
        defaultRequest: { ephemeralStorage: "1Gi" },
        defaultLimit: { ephemeralStorage: "5Gi" },
      },
    },
  },
});
```

- [ ] **Step 2: Run typecheck**

Run: `cd /Users/mariomeyer/code/ReyemTech/iac && npm run build`
Expected: 0 errors. (`build` runs `tsc` per iac's `package.json`.)

- [ ] **Step 3: Commit**

```bash
cd /Users/mariomeyer/code/ReyemTech/iac && \
  git add src/index.ts && \
  git commit -m "feat: add stop-gap apps namespace ephemeral-storage override

Pending reyemtech/sail resource hygiene fixes (separate spec).
Apps in 'apps' namespace get 1Gi request / 5Gi limit. All other
namespaces get the default 500Mi/2Gi from nimbus."
```

---

## Task 17: Pulumi preview + verify diff

**Files:** None modified (verification only).

- [ ] **Step 1: Run pulumi preview**

Run: `cd /Users/mariomeyer/code/ReyemTech/iac && pulumi preview --stack iad-1`
Expected output includes:
- `+ kubernetes:core/v1:LimitRange` × ~18 (one per non-system namespace)
- `+ kubernetes:apps/v1:DaemonSet` × 1, named `image-pruner` in `kube-system`
- 0 deletes, 0 replacements
- For the `apps` namespace LimitRange: shows `default.ephemeral-storage: 5Gi` and `defaultRequest.ephemeral-storage: 1Gi`
- For all other namespaces: shows `default.ephemeral-storage: 2Gi` and `defaultRequest.ephemeral-storage: 500Mi`

- [ ] **Step 2: If diff is unexpected — STOP**

Do NOT run `pulumi up` if any of these conditions appear:
- Updates or deletes to existing namespaces
- Fewer than ~17 LimitRange creates (suggests Helm-bypass — Task 13 missed entries)
- Replacements of any existing resource
- Errors mentioning unknown configs or types

Investigate root cause, fix, re-preview. Likely fixes:
- Re-run Task 2 audit if Helm-created namespaces are missing LimitRanges
- Verify Task 15 dependency bump landed correctly

(No commit — verification only.)

---

## Task 18: Pulumi up + monitor

**Files:** None modified (operational).

- [ ] **Step 1: Open monitoring terminals**

Open terminal A: `kubectl --context reyemtech-iad-1 get events -A -w | grep -E "(Evicted|FailedScheduling|OOMKilled)"`
Open terminal B: `kubectl --context reyemtech-iad-1 -n kube-system get pods -w -l app=image-pruner`

- [ ] **Step 2: Apply**

Run: `cd /Users/mariomeyer/code/ReyemTech/iac && pulumi up --stack iad-1 --yes`
Expected: ~19 creates, 0 updates/deletes, completes within ~2 min.

- [ ] **Step 3: Verify pruner is healthy**

Run: `kubectl --context reyemtech-iad-1 -n kube-system get ds image-pruner`
Expected: `DESIRED 4, CURRENT 4, READY 4, UP-TO-DATE 4, AVAILABLE 4`.

- [ ] **Step 4: Verify pruner logs show prune activity**

Run: `kubectl --context reyemtech-iad-1 -n kube-system logs -l app=image-pruner --tail=20 --prefix=true`
Expected: at least one pod shows `pruning unused images...` log line within ~30s of pod start.

- [ ] **Step 5: Verify LimitRanges exist with correct values**

Run: `kubectl --context reyemtech-iad-1 get limitrange -A`
Expected: ~18 entries, one named `default-limits` per non-system namespace.

Run: `kubectl --context reyemtech-iad-1 describe limitrange default-limits -n n8n`
Expected: shows `Container | ephemeral-storage | - | - | 500Mi | 2Gi |` row (default request, default limit columns).

Run: `kubectl --context reyemtech-iad-1 describe limitrange default-limits -n apps`
Expected: shows `Container | ephemeral-storage | - | - | 1Gi | 5Gi |` row (stop-gap override).

- [ ] **Step 6: Watch terminal A for 30 minutes**

Watch terminal A for `Evicted` events. If any pod outside the `apps` namespace is evicted with `ephemeral local storage usage exceeds 2Gi`:
1. Add an override for that namespace in `iac/src/index.ts`'s `namespacePolicies` map (e.g., `<ns>: { limitRange: { defaultRequest: { ephemeralStorage: "1Gi" }, defaultLimit: { ephemeralStorage: "5Gi" } } }`)
2. `pulumi up --stack iad-1 --yes`
3. Note the addition for the spec 2 brainstorm.

(No commit — operational. Any reactive override addition gets committed as a separate small commit.)

---

## Task 19: 24-hour disk pressure verification

**Files:** None modified (operational, deferred 24h).

- [ ] **Step 1: Compare node disk usage to baseline**

Run: `kubectl --context reyemtech-iad-1 top nodes`
Pre-rollout baseline (recorded 2026-04-15): nodes at 73-76% disk.
Expected: stable or trending down. If trending up, investigate (could be unrelated growth, or pruner not making progress).

For finer-grained data, also run on each node:
```bash
kubectl --context reyemtech-iad-1 -n kube-system exec ds/image-pruner -- df -h /
```

- [ ] **Step 2: Spot-check pruner activity**

Run: `kubectl --context reyemtech-iad-1 -n kube-system logs --tail=100 ds/image-pruner | grep -E "(pruning|removed|failed)"`
Expected: at least one prune cycle has run since rollout (4h+ depending on rollout time vs current time).

If "prune failed" appears, check the runtime endpoint and verify `/run/containerd/containerd.sock` is accessible.

- [ ] **Step 3: Check for late evictions**

Run: `kubectl --context reyemtech-iad-1 get events -A --field-selector reason=Evicted --sort-by=.lastTimestamp | tail -20`
Expected: empty, or only events older than the rollout time, or `apps`-namespace events that fall within the 5Gi override.

If any unexpected eviction → add namespace override per the reactive pattern in Task 18 Step 6.

- [ ] **Step 4: Update spec status**

If steps 1-3 are clean: no further action. The implementation is verified successful.

If issues persist: file findings as inputs to the spec 2 brainstorm (sail resource hygiene), since the most likely culprit is a Laravel app writing more than 5Gi to ephemeral.

(No commit — operational.)

---

## Self-Review Notes

**Spec coverage:**
- LimitRange via ensureNamespace ✓ (Tasks 4, 5, 6)
- Singleton override carrier ✓ (Tasks 4b, 5, 6, 16)
- Image pruner DaemonSet ✓ (Tasks 7, 8, 9, 10, 11)
- Stack wiring ✓ (Tasks 11, 12)
- iac stop-gap via singleton ✓ (Task 16)
- Helm-bypass audit ✓ (Tasks 2, 13)
- Pruner image choice ✓ (Tasks 1, 9)
- Operator namespace verification ✓ (Task 3)
- Manual cluster verification ✓ (Tasks 18, 19)
- Release + dependency bump ✓ (Task 15)

**Type consistency:** Names match across tasks: `INamespacePolicy`, `ILimitRangePolicy`, `DEFAULT_NAMESPACE_POLICY`, `SYSTEM_NAMESPACES`, `IImagePrunerConfig`, `IEnsureNamespaceOpts`, `createImagePruner`, `ensureNamespace`, `nimbus.namespacePolicies`. The k8s LimitRange field naming uses `defaultRequest` and `default` per Kubernetes spec — TypeScript interface uses `defaultRequest` and `defaultLimit` with the mapping happening inside `ensureNamespace`. Verified consistent in Tasks 4, 4b, 5, 6, 13, 16.

**Placeholder scan:** No "TBD"/"implement later" in code blocks. The `(TBD)` reference in Task 16's comment is intentional — the sail spec doesn't exist yet but the iac code needs a forward reference. Task 13 is conditionally skipped if Task 2 audit is empty — that's intentional gating, not a placeholder.

**Operational tasks (17, 18, 19):** Cannot be fully scripted because they involve cluster observation. Each step is concrete (exact `kubectl` command + expected output). The decision rules for reactive overrides are explicit.
