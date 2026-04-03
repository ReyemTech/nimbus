/**
 * Alerts overview Grafana dashboard — visualizes active, pending, and
 * resolved Prometheus alerts across all nimbus components.
 *
 * Uses the built-in Alertmanager datasource that kube-prometheus-stack
 * auto-configures in Grafana.
 *
 * @module observability/dashboards/alerts
 */

import { PROM_DS } from "./_helpers";

/** Build the alerts overview dashboard JSON. */
export function alertsDashboard(): Record<string, unknown> {
  return {
    uid: "nimbus-alerts-overview",
    title: "Nimbus / Alerts",
    tags: ["nimbus", "alerts", "overview"],
    timezone: "browser",
    editable: true,
    time: { from: "now-24h", to: "now" },
    refresh: "30s",
    panels: [
      // --- Row 1: Summary stats ---
      {
        id: 1,
        title: "Firing Alerts",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [{ expr: `count(ALERTS{alertstate="firing"}) or vector(0)`, refId: "A" }],
        fieldConfig: {
          defaults: {
            thresholds: {
              steps: [
                { color: "green", value: 0 },
                { color: "yellow", value: 1 },
                { color: "red", value: 3 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 2,
        title: "Pending Alerts",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 6, y: 0 },
        datasource: PROM_DS,
        targets: [{ expr: `count(ALERTS{alertstate="pending"}) or vector(0)`, refId: "A" }],
        fieldConfig: {
          defaults: {
            thresholds: {
              steps: [
                { color: "green", value: 0 },
                { color: "orange", value: 1 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 3,
        title: "Critical Firing",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 12, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `count(ALERTS{alertstate="firing",severity="critical"}) or vector(0)`,
            refId: "A",
          },
        ],
        fieldConfig: {
          defaults: {
            thresholds: {
              steps: [
                { color: "green", value: 0 },
                { color: "red", value: 1 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 4,
        title: "Warning Firing",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 18, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `count(ALERTS{alertstate="firing",severity="warning"}) or vector(0)`,
            refId: "A",
          },
        ],
        fieldConfig: {
          defaults: {
            thresholds: {
              steps: [
                { color: "green", value: 0 },
                { color: "yellow", value: 1 },
              ],
            },
          },
          overrides: [],
        },
      },
      // --- Row 2: Active alerts table ---
      {
        id: 5,
        title: "Currently Firing Alerts",
        type: "table",
        gridPos: { h: 8, w: 24, x: 0, y: 4 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `ALERTS{alertstate="firing"}`,
            refId: "A",
            format: "table",
            instant: true,
          },
        ],
        transformations: [
          {
            id: "organize",
            options: {
              excludeByName: { Time: true, __name__: true, Value: true },
              indexByName: { severity: 0, alertname: 1, namespace: 2, alertstate: 3 },
            },
          },
        ],
        fieldConfig: {
          defaults: {},
          overrides: [
            {
              matcher: { id: "byName", options: "severity" },
              properties: [
                {
                  id: "custom.cellOptions",
                  value: { type: "color-text" },
                },
                {
                  id: "mappings",
                  value: [
                    { type: "value", options: { critical: { color: "red", text: "CRITICAL" } } },
                    { type: "value", options: { warning: { color: "orange", text: "WARNING" } } },
                  ],
                },
              ],
            },
          ],
        },
      },
      // --- Row 3: Alert history timeline ---
      {
        id: 6,
        title: "Alert History (firing over time)",
        type: "timeseries",
        gridPos: { h: 8, w: 24, x: 0, y: 12 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `ALERTS{alertstate="firing"}`,
            refId: "A",
            legendFormat: "{{ alertname }} ({{ severity }})",
          },
        ],
        fieldConfig: {
          defaults: {
            custom: { drawStyle: "bars", fillOpacity: 80, stacking: { mode: "normal" } },
          },
          overrides: [],
        },
      },
      // --- Row 4: Per-component alert counts ---
      {
        id: 7,
        title: "Alerts by Component",
        type: "bargauge",
        gridPos: { h: 8, w: 12, x: 0, y: 20 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `count by (alertname) (ALERTS{alertstate="firing"})`,
            refId: "A",
            legendFormat: "{{ alertname }}",
            instant: true,
          },
        ],
        fieldConfig: {
          defaults: {
            thresholds: {
              steps: [
                { color: "yellow", value: 0 },
                { color: "red", value: 1 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 8,
        title: "Alert Rate (firing events/hour)",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 20 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `sum by (alertname) (changes(ALERTS{alertstate="firing"}[1h]))`,
            refId: "A",
            legendFormat: "{{ alertname }}",
          },
        ],
        fieldConfig: { defaults: { unit: "short" }, overrides: [] },
      },
      // --- Row 5: Notification health ---
      {
        id: 9,
        title: "Alertmanager Notifications Sent",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 28 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `rate(alertmanager_notifications_total[5m])`,
            refId: "A",
            legendFormat: "{{ integration }}",
          },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 10,
        title: "Alertmanager Notification Failures",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 28 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `rate(alertmanager_notifications_failed_total[5m])`,
            refId: "A",
            legendFormat: "{{ integration }}",
          },
        ],
        fieldConfig: {
          defaults: { unit: "ops", color: { mode: "fixed", fixedColor: "red" } },
          overrides: [],
        },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}
