/**
 * Trivy Operator security findings overview.
 *
 * @module observability/dashboards/trivy
 */

import { PROM_DS } from "./_helpers";

export function trivyDashboard(): Record<string, unknown> {
  return {
    uid: "nimbus-trivy-security",
    title: "Nimbus / Security / Trivy",
    tags: ["nimbus", "security", "trivy", "vulnerabilities"],
    timezone: "browser",
    editable: true,
    time: { from: "now-24h", to: "now" },
    refresh: "5m",
    panels: [
      {
        id: 1,
        title: "Image Vulnerabilities by Severity",
        type: "bargauge",
        gridPos: { h: 8, w: 12, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum by (severity) (trivy_image_vulnerabilities)",
            refId: "A",
            legendFormat: "{{severity}}",
          },
        ],
        options: { orientation: "horizontal", displayMode: "gradient" },
        fieldConfig: { defaults: { min: 0 }, overrides: [] },
      },
      {
        id: 2,
        title: "Configuration Findings by Severity",
        type: "bargauge",
        gridPos: { h: 8, w: 12, x: 12, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum by (severity) (trivy_resource_configaudits)",
            refId: "A",
            legendFormat: "{{severity}}",
          },
        ],
        options: { orientation: "horizontal", displayMode: "gradient" },
        fieldConfig: { defaults: { min: 0 }, overrides: [] },
      },
      {
        id: 3,
        title: "Top Workloads: Critical and High CVEs",
        type: "table",
        gridPos: { h: 10, w: 24, x: 0, y: 8 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'topk(20, sum by (namespace, resource_kind, resource_name, image_repository, image_tag) (trivy_image_vulnerabilities{severity=~"Critical|High"}))',
            refId: "A",
            format: "table",
            instant: true,
          },
        ],
        options: { showHeader: true },
        fieldConfig: { defaults: { custom: { align: "auto" } }, overrides: [] },
      },
      {
        id: 4,
        title: "Exposed Secrets by Namespace",
        type: "bargauge",
        gridPos: { h: 8, w: 12, x: 0, y: 18 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum by (namespace) (trivy_image_exposedsecrets)",
            refId: "A",
            legendFormat: "{{namespace}}",
          },
        ],
        options: { orientation: "horizontal", displayMode: "gradient" },
        fieldConfig: { defaults: { min: 0 }, overrides: [] },
      },
      {
        id: 5,
        title: "RBAC Assessment Findings",
        type: "bargauge",
        gridPos: { h: 8, w: 12, x: 12, y: 18 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum by (severity) (trivy_clusterrole_clusterrbacassessments)",
            refId: "A",
            legendFormat: "{{severity}}",
          },
        ],
        options: { orientation: "horizontal", displayMode: "gradient" },
        fieldConfig: { defaults: { min: 0 }, overrides: [] },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}
