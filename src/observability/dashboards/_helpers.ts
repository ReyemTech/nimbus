/**
 * Shared constants and ConfigMap helper for Grafana dashboard provisioning.
 *
 * @module observability/dashboards/_helpers
 */

import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";

/** Prometheus datasource reference for dashboard panels. */
export const PROM_DS = { type: "prometheus", uid: "prometheus" };

/**
 * Build a PVC disk usage gauge + timeseries row for per-cluster dashboards.
 *
 * @param pvcFilter - PromQL label filter matching the PVCs (e.g., `persistentvolumeclaim=~"pgsql-main-.*"`)
 * @param startId - Starting panel ID
 * @param yPos - Grid Y position
 * @returns Array of panel objects
 */
export function pvcDiskUsagePanels(
  pvcFilter: string,
  startId: number,
  yPos: number
): Record<string, unknown>[] {
  return [
    {
      id: startId,
      title: "PVC Disk Usage",
      type: "gauge",
      gridPos: { h: 8, w: 12, x: 0, y: yPos },
      datasource: PROM_DS,
      targets: [
        {
          expr: `kubelet_volume_stats_used_bytes{namespace="data",${pvcFilter}} / kubelet_volume_stats_capacity_bytes{namespace="data",${pvcFilter}}`,
          refId: "A",
          legendFormat: "{{persistentvolumeclaim}}",
          instant: true,
        },
      ],
      fieldConfig: {
        defaults: {
          unit: "percentunit", min: 0, max: 1,
          thresholds: {
            steps: [
              { color: "green", value: 0 },
              { color: "yellow", value: 0.75 },
              { color: "red", value: 0.9 },
            ],
          },
        },
        overrides: [],
      },
    },
    {
      id: startId + 1,
      title: "PVC Disk Used vs Capacity",
      type: "timeseries",
      gridPos: { h: 8, w: 12, x: 12, y: yPos },
      datasource: PROM_DS,
      targets: [
        {
          expr: `kubelet_volume_stats_used_bytes{namespace="data",${pvcFilter}}`,
          refId: "A",
          legendFormat: "{{persistentvolumeclaim}} used",
        },
        {
          expr: `kubelet_volume_stats_capacity_bytes{namespace="data",${pvcFilter}}`,
          refId: "B",
          legendFormat: "{{persistentvolumeclaim}} capacity",
        },
      ],
      fieldConfig: {
        defaults: { unit: "bytes" },
        overrides: [
          {
            matcher: { id: "byRegexp", options: ".*capacity" },
            properties: [{ id: "custom.lineStyle", value: { fill: "dash", dash: [10, 10] } }],
          },
        ],
      },
    },
  ];
}

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
