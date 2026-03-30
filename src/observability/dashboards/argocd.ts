/**
 * ArgoCD Grafana dashboard — sync status, app health, kubectl and redis
 * request rates/latencies, and login attempts.
 *
 * @module observability/dashboards/argocd
 */

import { PROM_DS } from "./_helpers";

/** Grafana dashboard JSON for ArgoCD metrics (8 panels). */
export function argocdDashboard(): Record<string, unknown> {
  return {
    uid: "nimbus-argocd",
    title: "Nimbus / ArgoCD",
    tags: ["nimbus", "argocd"],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    refresh: "30s",
    panels: [
      {
        id: 1,
        title: "Apps by Sync Status",
        type: "piechart",
        gridPos: { h: 8, w: 8, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "count(argocd_app_info) by (sync_status)",
            refId: "A",
            legendFormat: "{{sync_status}}",
          },
        ],
      },
      {
        id: 2,
        title: "Apps by Health",
        type: "piechart",
        gridPos: { h: 8, w: 8, x: 8, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "count(argocd_app_info) by (health_status)",
            refId: "A",
            legendFormat: "{{health_status}}",
          },
        ],
      },
      {
        id: 3,
        title: "Sync Rate",
        type: "timeseries",
        gridPos: { h: 8, w: 8, x: 16, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum(rate(argocd_app_sync_total[5m])) by (phase)",
            refId: "A",
            legendFormat: "{{phase}}",
          },
        ],
      },
      {
        id: 4,
        title: "Kubectl Request Rate",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 8 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum(rate(argocd_kubectl_requests_total[5m])) by (verb)",
            refId: "A",
            legendFormat: "{{verb}}",
          },
        ],
      },
      {
        id: 5,
        title: "Kubectl Latency p95",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 8 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "histogram_quantile(0.95, sum(rate(argocd_kubectl_request_duration_seconds_bucket[5m])) by (le))",
            refId: "A",
            legendFormat: "p95",
          },
        ],
        fieldConfig: { defaults: { unit: "s" }, overrides: [] },
      },
      {
        id: 6,
        title: "Redis Request Rate",
        type: "timeseries",
        gridPos: { h: 8, w: 8, x: 0, y: 16 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum(rate(argocd_redis_request_total[5m]))",
            refId: "A",
            legendFormat: "requests/s",
          },
        ],
      },
      {
        id: 7,
        title: "Redis Latency p95",
        type: "timeseries",
        gridPos: { h: 8, w: 8, x: 8, y: 16 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "histogram_quantile(0.95, sum(rate(argocd_redis_request_duration_bucket[5m])) by (le))",
            refId: "A",
            legendFormat: "p95",
          },
        ],
        fieldConfig: { defaults: { unit: "s" }, overrides: [] },
      },
      {
        id: 8,
        title: "Login Attempts",
        type: "timeseries",
        gridPos: { h: 8, w: 8, x: 16, y: 16 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum(rate(argocd_login_request_total[5m])) by (result)",
            refId: "A",
            legendFormat: "{{result}}",
          },
        ],
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}
