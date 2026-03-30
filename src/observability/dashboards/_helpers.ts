/**
 * Shared constants and ConfigMap helper for Grafana dashboard provisioning.
 *
 * @module observability/dashboards/_helpers
 */

import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";

/** Prometheus datasource reference for dashboard panels. */
export const PROM_DS = { type: "prometheus", uid: "prometheus" };

/** Label that tells the Grafana sidecar to pick up the ConfigMap as a dashboard. */
export const FOLDER_LABEL = { grafana_dashboard: "1" };

/**
 * Create a Kubernetes ConfigMap containing a Grafana dashboard JSON.
 *
 * @param name - Stack name prefix
 * @param dashName - Short dashboard identifier (used in resource + file name)
 * @param json - Dashboard JSON object
 * @param namespace - Target namespace for the ConfigMap
 * @param provider - Kubernetes provider
 * @param dependsOn - Resources that must exist first
 * @param folderOverride - Grafana folder name (defaults to "Nimbus")
 */
export function createDashboardConfigMap(
  name: string,
  dashName: string,
  json: Record<string, unknown>,
  namespace: string,
  provider: k8s.Provider,
  dependsOn: pulumi.Resource[],
  folderOverride?: string
): void {
  new k8s.core.v1.ConfigMap(
    `${name}-dashboard-${dashName}`,
    {
      metadata: {
        name: `${name}-${dashName}-dashboard`,
        namespace,
        labels: FOLDER_LABEL,
        annotations: { grafana_folder: folderOverride ?? "Nimbus" },
      },
      data: { [`${dashName}.json`]: JSON.stringify(json) },
    },
    { provider, dependsOn }
  );
}
