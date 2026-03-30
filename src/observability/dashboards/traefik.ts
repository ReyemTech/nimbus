/**
 * Traefik ingress Grafana dashboard — request rates, latency, bandwidth,
 * error rates, TLS cert expiry, and a services overview table.
 *
 * @module observability/dashboards/traefik
 */

import { PROM_DS } from "./_helpers";

/** Grafana dashboard JSON for Traefik ingress metrics (~15 panels). */
export function traefikDashboard(): Record<string, unknown> {
  return {
    uid: "nimbus-traefik",
    title: "Nimbus / Traefik",
    tags: ["nimbus", "traefik"],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    refresh: "30s",
    panels: [
      // ── Row 1 — Stats (h:4) ──────────────────────────────────────────
      {
        id: 100,
        title: "Stats",
        type: "row",
        gridPos: { h: 1, w: 24, x: 0, y: 0 },
        collapsed: false,
      },
      {
        id: 1,
        title: "Total Requests/sec",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 0, y: 1 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum(rate(traefik_service_requests_total[5m]))",
            refId: "A",
            legendFormat: "req/s",
          },
        ],
        fieldConfig: {
          defaults: { unit: "reqps", thresholds: { steps: [{ color: "green", value: 0 }] } },
          overrides: [],
        },
      },
      {
        id: 2,
        title: "Active Connections",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 6, y: 1 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum(traefik_open_connections)",
            refId: "A",
            legendFormat: "connections",
          },
        ],
        fieldConfig: {
          defaults: { thresholds: { steps: [{ color: "green", value: 0 }] } },
          overrides: [],
        },
      },
      {
        id: 3,
        title: "Error Rate %",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 12, y: 1 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'sum(rate(traefik_service_requests_total{code=~"5.."}[5m])) / sum(rate(traefik_service_requests_total[5m])) * 100',
            refId: "A",
            legendFormat: "5xx %",
          },
        ],
        fieldConfig: {
          defaults: {
            unit: "percent",
            thresholds: {
              steps: [
                { color: "green", value: 0 },
                { color: "red", value: 5 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 4,
        title: "TLS Cert Days Left",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 18, y: 1 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "min((traefik_tls_certs_not_after - time()) / 86400)",
            refId: "A",
            legendFormat: "days",
          },
        ],
        fieldConfig: {
          defaults: {
            unit: "d",
            thresholds: {
              steps: [
                { color: "red", value: 0 },
                { color: "yellow", value: 14 },
                { color: "green", value: 30 },
              ],
            },
          },
          overrides: [],
        },
      },

      // ── Row 2 — Traffic (h:8) ────────────────────────────────────────
      {
        id: 101,
        title: "Traffic",
        type: "row",
        gridPos: { h: 1, w: 24, x: 0, y: 5 },
        collapsed: false,
      },
      {
        id: 5,
        title: "Requests/sec by Service",
        type: "timeseries",
        gridPos: { h: 8, w: 10, x: 0, y: 6 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum(rate(traefik_service_requests_total[5m])) by (service)",
            refId: "A",
            legendFormat: "{{service}}",
          },
        ],
        fieldConfig: {
          defaults: { unit: "reqps", custom: { stacking: { mode: "normal" }, fillOpacity: 20 } },
          overrides: [],
        },
      },
      {
        id: 6,
        title: "Requests/sec by Status Code",
        type: "timeseries",
        gridPos: { h: 8, w: 8, x: 10, y: 6 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum(rate(traefik_service_requests_total[5m])) by (code)",
            refId: "A",
            legendFormat: "{{code}}",
          },
        ],
        fieldConfig: {
          defaults: { unit: "reqps" },
          overrides: [
            {
              matcher: { id: "byRegexp", options: "^2" },
              properties: [{ id: "color", value: { mode: "fixed", fixedColor: "green" } }],
            },
            {
              matcher: { id: "byRegexp", options: "^3" },
              properties: [{ id: "color", value: { mode: "fixed", fixedColor: "blue" } }],
            },
            {
              matcher: { id: "byRegexp", options: "^4" },
              properties: [{ id: "color", value: { mode: "fixed", fixedColor: "yellow" } }],
            },
            {
              matcher: { id: "byRegexp", options: "^5" },
              properties: [{ id: "color", value: { mode: "fixed", fixedColor: "red" } }],
            },
          ],
        },
      },
      {
        id: 7,
        title: "Requests by Method",
        type: "piechart",
        gridPos: { h: 8, w: 6, x: 18, y: 6 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum(rate(traefik_service_requests_total[5m])) by (method)",
            refId: "A",
            legendFormat: "{{method}}",
          },
        ],
      },

      // ── Row 3 — Latency (h:8) ────────────────────────────────────────
      {
        id: 102,
        title: "Latency",
        type: "row",
        gridPos: { h: 1, w: 24, x: 0, y: 14 },
        collapsed: false,
      },
      {
        id: 8,
        title: "Latency p50/p95/p99 by Service",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 15 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "histogram_quantile(0.50, sum(rate(traefik_service_request_duration_seconds_bucket[5m])) by (service, le))",
            refId: "A",
            legendFormat: "{{service}} p50",
          },
          {
            expr: "histogram_quantile(0.95, sum(rate(traefik_service_request_duration_seconds_bucket[5m])) by (service, le))",
            refId: "B",
            legendFormat: "{{service}} p95",
          },
          {
            expr: "histogram_quantile(0.99, sum(rate(traefik_service_request_duration_seconds_bucket[5m])) by (service, le))",
            refId: "C",
            legendFormat: "{{service}} p99",
          },
        ],
        fieldConfig: { defaults: { unit: "s" }, overrides: [] },
      },
      {
        id: 9,
        title: "Latency Heatmap",
        type: "heatmap",
        gridPos: { h: 8, w: 12, x: 12, y: 15 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum(rate(traefik_service_request_duration_seconds_bucket[5m])) by (le)",
            refId: "A",
            format: "heatmap",
            legendFormat: "{{le}}",
          },
        ],
        options: {
          calculate: false,
          yAxis: { unit: "s" },
          color: { scheme: "Oranges" },
        },
      },

      // ── Row 4 — Bandwidth (h:6) ──────────────────────────────────────
      {
        id: 103,
        title: "Bandwidth",
        type: "row",
        gridPos: { h: 1, w: 24, x: 0, y: 23 },
        collapsed: false,
      },
      {
        id: 10,
        title: "Request Bandwidth by Service",
        type: "timeseries",
        gridPos: { h: 6, w: 12, x: 0, y: 24 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum(rate(traefik_service_requests_bytes_total[5m])) by (service)",
            refId: "A",
            legendFormat: "{{service}}",
          },
        ],
        fieldConfig: { defaults: { unit: "Bps" }, overrides: [] },
      },
      {
        id: 11,
        title: "Response Bandwidth by Service",
        type: "timeseries",
        gridPos: { h: 6, w: 12, x: 12, y: 24 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum(rate(traefik_service_responses_bytes_total[5m])) by (service)",
            refId: "A",
            legendFormat: "{{service}}",
          },
        ],
        fieldConfig: { defaults: { unit: "Bps" }, overrides: [] },
      },

      // ── Row 5 — Services Table (h:8) ─────────────────────────────────
      {
        id: 104,
        title: "Services Overview",
        type: "row",
        gridPos: { h: 1, w: 24, x: 0, y: 30 },
        collapsed: false,
      },
      {
        id: 12,
        title: "Services Table",
        type: "table",
        gridPos: { h: 8, w: 24, x: 0, y: 31 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum(rate(traefik_service_requests_total[5m])) by (service)",
            refId: "A",
            legendFormat: "Req/s",
            instant: true,
            format: "table",
          },
          {
            expr: 'sum(rate(traefik_service_requests_total{code=~"5.."}[5m])) by (service) / sum(rate(traefik_service_requests_total[5m])) by (service) * 100',
            refId: "B",
            legendFormat: "Error %",
            instant: true,
            format: "table",
          },
          {
            expr: "histogram_quantile(0.95, sum(rate(traefik_service_request_duration_seconds_bucket[5m])) by (service, le))",
            refId: "C",
            legendFormat: "p95 (s)",
            instant: true,
            format: "table",
          },
          {
            expr: "sum(rate(traefik_service_responses_bytes_total[5m])) by (service)",
            refId: "D",
            legendFormat: "Resp Bps",
            instant: true,
            format: "table",
          },
        ],
        transformations: [
          { id: "merge", options: {} },
          {
            id: "organize",
            options: {
              excludeByName: { Time: true },
              renameByName: {
                "Value #A": "Req/s",
                "Value #B": "Error %",
                "Value #C": "p95 (s)",
                "Value #D": "Resp Bps",
              },
            },
          },
        ],
      },

      // ── Row 6 — Config (h:4) ─────────────────────────────────────────
      {
        id: 105,
        title: "Config",
        type: "row",
        gridPos: { h: 1, w: 24, x: 0, y: 39 },
        collapsed: false,
      },
      {
        id: 13,
        title: "Config Reloads",
        type: "timeseries",
        gridPos: { h: 4, w: 12, x: 0, y: 40 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "rate(traefik_config_reloads_total[5m])",
            refId: "A",
            legendFormat: "reloads/s",
          },
        ],
      },
      {
        id: 14,
        title: "Entrypoint Requests",
        type: "timeseries",
        gridPos: { h: 4, w: 12, x: 12, y: 40 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum(rate(traefik_entrypoint_requests_total[5m])) by (entrypoint)",
            refId: "A",
            legendFormat: "{{entrypoint}}",
          },
        ],
        fieldConfig: { defaults: { unit: "reqps" }, overrides: [] },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}
