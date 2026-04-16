import * as k8s from "@pulumi/kubernetes";
import type { INamespacePolicy } from "../platform/interfaces";
import {
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
