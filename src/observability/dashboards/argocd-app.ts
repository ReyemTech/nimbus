/**
 * Per-app Grafana dashboard — auto-generated for each ArgoCD Application.
 *
 * Filtered by app.kubernetes.io/instance=<appName>.
 * Shows: ArgoCD sync status, pods, CPU/memory, PVCs.
 *
 * @module observability/dashboards/argocd-app
 */

import * as k8s from "@pulumi/kubernetes";
import { PROM_DS } from "./_helpers";

const OBSERVABILITY_NAMESPACE = "observability";

/**
 * Generate a Grafana dashboard JSON for a specific ArgoCD app.
 */
function argoAppDashboardJson(appName: string): Record<string, unknown> {
  const label = `app_kubernetes_io_instance="${appName}"`;

  return {
    uid: `nimbus-app-${appName}`,
    title: `Nimbus / App: ${appName}`,
    tags: ["nimbus", "argocd-app", appName],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    refresh: "30s",
    templating: { list: [] },
    panels: [
      // Row 1: ArgoCD sync + health
      {
        id: 1,
        title: "Sync Status",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [{ expr: `argocd_app_info{name="${appName}"}`, refId: "A", legendFormat: "{{sync_status}}" }],
        fieldConfig: { defaults: { mappings: [{ type: "value", options: { "1": { text: "Synced", color: "green" } } }] } },
      },
      {
        id: 2,
        title: "Health Status",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 6, y: 0 },
        datasource: PROM_DS,
        targets: [{ expr: `argocd_app_info{name="${appName}"}`, refId: "A", legendFormat: "{{health_status}}" }],
      },
      {
        id: 3,
        title: "Last Sync",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 12, y: 0 },
        datasource: PROM_DS,
        targets: [{ expr: `argocd_app_info{name="${appName}"}`, refId: "A" }],
        fieldConfig: { defaults: { unit: "dateTimeAsIso" } },
      },
      // Row 2: Pod status
      {
        id: 10,
        title: "Pods",
        type: "table",
        gridPos: { h: 8, w: 24, x: 0, y: 4 },
        datasource: PROM_DS,
        targets: [
          { expr: `kube_pod_info{${label}}`, refId: "A", format: "table", instant: true },
        ],
      },
      // Row 3: CPU + Memory
      {
        id: 20,
        title: "CPU Usage",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 12 },
        datasource: PROM_DS,
        targets: [
          { expr: `sum(rate(container_cpu_usage_seconds_total{${label}}[5m])) by (pod)`, refId: "A", legendFormat: "{{pod}}" },
        ],
      },
      {
        id: 21,
        title: "Memory Usage",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 12 },
        datasource: PROM_DS,
        targets: [
          { expr: `sum(container_memory_working_set_bytes{${label}}) by (pod)`, refId: "A", legendFormat: "{{pod}}" },
        ],
        fieldConfig: { defaults: { unit: "bytes" } },
      },
      // Row 4: PVC usage
      {
        id: 30,
        title: "PVC Usage",
        type: "bargauge",
        gridPos: { h: 8, w: 24, x: 0, y: 20 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `kubelet_volume_stats_used_bytes{${label}} / kubelet_volume_stats_capacity_bytes{${label}} * 100`,
            refId: "A",
            legendFormat: "{{persistentvolumeclaim}}",
          },
        ],
        fieldConfig: { defaults: { unit: "percent", max: 100, thresholds: { steps: [{ value: 0, color: "green" }, { value: 75, color: "yellow" }, { value: 90, color: "red" }] } } },
      },
      // Row 5: Pod restarts
      {
        id: 40,
        title: "Container Restarts",
        type: "timeseries",
        gridPos: { h: 8, w: 24, x: 0, y: 28 },
        datasource: PROM_DS,
        targets: [
          { expr: `increase(kube_pod_container_status_restarts_total{${label}}[1h])`, refId: "A", legendFormat: "{{pod}} / {{container}}" },
        ],
      },
    ],
  };
}

/**
 * Create a Grafana dashboard ConfigMap for an ArgoCD app.
 */
export function createArgoAppDashboard(
  appName: string,
  provider: k8s.Provider
): void {
  new k8s.core.v1.ConfigMap(
    `nimbus-dashboard-app-${appName}`,
    {
      metadata: {
        name: `nimbus-dashboard-app-${appName}`,
        namespace: OBSERVABILITY_NAMESPACE,
        labels: { grafana_dashboard: "1" },
      },
      data: {
        [`app-${appName}.json`]: JSON.stringify(argoAppDashboardJson(appName)),
      },
    },
    { provider }
  );
}
