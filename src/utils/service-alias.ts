/**
 * Create a clean-name ExternalName alias for a Helm-managed K8s Service.
 *
 * Maps short names like "grafana" to the full Helm-generated service name,
 * enabling clean DNS resolution via split DNS (e.g., grafana.iad-1.internal).
 *
 * All aliases are created in the access namespace so a single CoreDNS
 * rewrite rule handles all services: <alias>.iad-1.internal → <alias>.access.svc.cluster.local
 *
 * @module utils/service-alias
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ensureNamespace } from "./ensure-namespace";

/**
 * Create an ExternalName service alias in the access namespace.
 *
 * @param resourceName - Pulumi resource name
 * @param alias - Clean short name (e.g., "grafana")
 * @param target - Original service name or Output<string>
 * @param targetNamespace - Namespace where the real service lives
 * @param aliasNamespace - Namespace for the alias (default: "access")
 * @param provider - K8s provider
 * @param dependsOn - Resources to depend on
 */
export function createServiceAlias(
  resourceName: string,
  alias: string,
  target: string | pulumi.Output<string>,
  targetNamespace: string,
  aliasNamespace: string,
  provider: k8s.Provider,
  dependsOn?: pulumi.Resource[]
): k8s.core.v1.Service {
  const nsResource = ensureNamespace(aliasNamespace, provider);
  const externalName = pulumi
    .output(target)
    .apply((t) => `${t}.${targetNamespace}.svc.cluster.local`);

  return new k8s.core.v1.Service(
    resourceName,
    {
      metadata: {
        name: alias,
        namespace: aliasNamespace,
        labels: {
          "app.kubernetes.io/managed-by": "nimbus",
          "nimbus/alias-for": pulumi.output(target),
        },
      },
      spec: {
        type: "ExternalName",
        externalName,
      },
    },
    { provider, dependsOn: [...(dependsOn ?? []), nsResource] }
  );
}
