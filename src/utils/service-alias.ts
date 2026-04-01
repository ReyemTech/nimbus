/**
 * Create a clean-name ExternalName alias for a Helm-managed K8s Service.
 *
 * Maps short names like "grafana" to the full Helm-generated service name,
 * enabling clean DNS resolution via split DNS (e.g., grafana.observability.iad-1.internal).
 *
 * @module utils/service-alias
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";

/**
 * Create an ExternalName service alias.
 *
 * @param resourceName - Pulumi resource name
 * @param alias - Clean short name (e.g., "grafana")
 * @param target - Original service name or Output<string> (e.g., "reyemtech-kube-prometheus-stack-44421f7b-grafana")
 * @param namespace - K8s namespace
 * @param provider - K8s provider
 * @param dependsOn - Resources to depend on
 */
export function createServiceAlias(
  resourceName: string,
  alias: string,
  target: string | pulumi.Output<string>,
  namespace: string,
  provider: k8s.Provider,
  dependsOn?: pulumi.Resource[]
): k8s.core.v1.Service {
  const externalName = pulumi
    .output(target)
    .apply((t) => `${t}.${namespace}.svc.cluster.local`);

  return new k8s.core.v1.Service(
    resourceName,
    {
      metadata: {
        name: alias,
        namespace,
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
    { provider, dependsOn }
  );
}
