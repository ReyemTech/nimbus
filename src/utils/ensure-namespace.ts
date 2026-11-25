import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { INamespacePolicy } from "../platform/interfaces";
import { DEFAULT_NAMESPACE_POLICY, SYSTEM_NAMESPACES } from "../platform/interfaces";
import { nimbus } from "../nimbus";

const createdNamespaces = new WeakMap<k8s.Provider, Map<string, k8s.core.v1.Namespace>>();
const namespaceOwners = new Map<string, k8s.Provider>();

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
 * Idempotent per Kubernetes provider — returns the same Namespace resource for
 * repeated calls targeting the same cluster, while allowing multiple clusters
 * to use a namespace with the same name in one Pulumi program.
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
  let providerNamespaces = createdNamespaces.get(provider);
  if (!providerNamespaces) {
    providerNamespaces = new Map<string, k8s.core.v1.Namespace>();
    createdNamespaces.set(provider, providerNamespaces);
  }

  const existing = providerNamespaces.get(name);
  if (existing) {
    return existing;
  }
  const isLegacyIdentityOwner = !namespaceOwners.has(name);
  if (isLegacyIdentityOwner) namespaceOwners.set(name, provider);
  const identityOptions: pulumi.CustomResourceOptions = {
    provider,
    parent: provider,
    ...(isLegacyIdentityOwner ? { aliases: [{ parent: pulumi.rootStackResource }] } : {}),
  };
  const ns = new k8s.core.v1.Namespace(
    `ensure-ns-${name}`,
    { metadata: { name } },
    identityOptions
  );
  providerNamespaces.set(name, ns);

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
            defaultRequest: toK8sResources(policy.limitRange.defaultRequest),
            default: toK8sResources(policy.limitRange.defaultLimit),
          },
        ],
      },
    },
    { ...identityOptions, dependsOn: [ns] }
  );

  return ns;
}

/**
 * Convert TypeScript camelCase resource keys (`ephemeralStorage`) to the
 * hyphenated form Kubernetes requires (`ephemeral-storage`). `cpu` and
 * `memory` are passed through unchanged. Undefined fields are omitted.
 */
function toK8sResources(input: {
  cpu?: string;
  memory?: string;
  ephemeralStorage?: string;
}): Record<string, string> {
  const out: Record<string, string> = {};
  if (input.cpu !== undefined) out.cpu = input.cpu;
  if (input.memory !== undefined) out.memory = input.memory;
  if (input.ephemeralStorage !== undefined) out["ephemeral-storage"] = input.ephemeralStorage;
  return out;
}
