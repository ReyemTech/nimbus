/**
 * Cert-manager Grafana dashboard — certificate readiness, expiry timelines,
 * ACME request rates, and controller sync errors.
 *
 * @module observability/dashboards/cert-manager
 */

import { PROM_DS } from "./_helpers";

/** Grafana dashboard JSON for cert-manager certificate monitoring (6 panels). */
export function certManagerDashboard(): Record<string, unknown> {
  return {
    uid: "nimbus-cert-manager",
    title: "Nimbus / Cert-Manager",
    tags: ["nimbus", "cert-manager"],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    refresh: "30s",
    panels: [
      {
        id: 1,
        title: "Certificates Ready",
        type: "stat",
        gridPos: { h: 6, w: 6, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'count(certmanager_certificate_ready_status{condition="True"})',
            refId: "A",
            legendFormat: "Ready",
          },
        ],
        fieldConfig: {
          defaults: { thresholds: { steps: [{ color: "green", value: 0 }] } },
          overrides: [],
        },
      },
      {
        id: 2,
        title: "Certificates Not Ready",
        type: "stat",
        gridPos: { h: 6, w: 6, x: 6, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'count(certmanager_certificate_ready_status{condition="False"})',
            refId: "A",
            legendFormat: "Not Ready",
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
        id: 3,
        title: "Certificate Expiry Timeline",
        type: "timeseries",
        gridPos: { h: 6, w: 12, x: 12, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "(certmanager_certificate_expiration_timestamp_seconds - time()) / 86400",
            refId: "A",
            legendFormat: "{{name}} ({{namespace}})",
          },
        ],
        fieldConfig: {
          defaults: {
            unit: "d",
            thresholds: {
              steps: [
                { color: "red", value: 0 },
                { color: "yellow", value: 7 },
                { color: "green", value: 30 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 4,
        title: "Certificates Expiring",
        type: "table",
        gridPos: { h: 8, w: 24, x: 0, y: 6 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "(certmanager_certificate_expiration_timestamp_seconds - time()) / 86400",
            refId: "A",
            legendFormat: "{{name}}",
            instant: true,
            format: "table",
          },
        ],
        transformations: [
          {
            id: "organize",
            options: {
              excludeByName: { Time: true, __name__: true },
              renameByName: { Value: "Days Remaining" },
            },
          },
        ],
        fieldConfig: {
          defaults: {
            unit: "d",
            thresholds: {
              steps: [
                { color: "red", value: 0 },
                { color: "yellow", value: 7 },
                { color: "green", value: 30 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 5,
        title: "ACME Requests",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 14 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "rate(certmanager_http_acme_client_request_count[5m])",
            refId: "A",
            legendFormat: "{{status}}",
          },
        ],
      },
      {
        id: 6,
        title: "Controller Sync Errors",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 14 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "rate(certmanager_controller_sync_error_count[5m])",
            refId: "A",
            legendFormat: "{{controller}}",
          },
        ],
        fieldConfig: {
          defaults: { color: { mode: "fixed", fixedColor: "red" } },
          overrides: [],
        },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}
