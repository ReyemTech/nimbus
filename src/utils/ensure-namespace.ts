import * as k8s from "@pulumi/kubernetes";

const createdNamespaces = new Map<string, k8s.core.v1.Namespace>();

/**
 * Ensure a Kubernetes namespace exists. Creates it if it doesn't.
 * Idempotent — returns the same Namespace resource for repeated calls.
 */
export function ensureNamespace(
  name: string,
  provider: k8s.Provider
): k8s.core.v1.Namespace {
  const key = `${name}`;
  if (createdNamespaces.has(key)) {
    return createdNamespaces.get(key)!;
  }
  const ns = new k8s.core.v1.Namespace(
    `ensure-ns-${name}`,
    { metadata: { name } },
    { provider }
  );
  createdNamespaces.set(key, ns);
  return ns;
}
