/**
 * MinIO Grafana dashboard — S3 object storage metrics from the MinIO
 * Operator Tenant. Metric names match the MinIO v2 metrics API.
 *
 * @module observability/dashboards/minio
 */

import { PROM_DS, pvcDiskUsagePanels } from "./_helpers";

/** Build the MinIO overview dashboard JSON. */
export function minioDashboard(): Record<string, unknown> {
  return {
    uid: "nimbus-minio-overview",
    title: "Nimbus / Data / MinIO",
    tags: ["nimbus", "minio", "s3", "object-storage"],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    refresh: "30s",
    panels: [
      // --- Row 1: Cluster status ---
      {
        id: 1,
        title: "Cluster Health",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [{ expr: `minio_cluster_health_status`, refId: "A", legendFormat: "health" }],
        fieldConfig: {
          defaults: {
            mappings: [
              {
                type: "value",
                options: {
                  "1": { text: "Healthy", color: "green" },
                  "0": { text: "Unhealthy", color: "red" },
                },
              },
            ],
          },
          overrides: [],
        },
      },
      {
        id: 2,
        title: "Storage Used",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 6, y: 0 },
        datasource: PROM_DS,
        targets: [{ expr: `minio_cluster_usage_total_bytes`, refId: "A" }],
        fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
      },
      {
        id: 3,
        title: "Objects",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 12, y: 0 },
        datasource: PROM_DS,
        targets: [{ expr: `minio_cluster_usage_object_total`, refId: "A" }],
        fieldConfig: {
          defaults: { thresholds: { steps: [{ color: "blue", value: 0 }] } },
          overrides: [],
        },
      },
      {
        id: 4,
        title: "Buckets",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 18, y: 0 },
        datasource: PROM_DS,
        targets: [{ expr: `minio_cluster_bucket_total`, refId: "A" }],
        fieldConfig: {
          defaults: { thresholds: { steps: [{ color: "blue", value: 0 }] } },
          overrides: [],
        },
      },
      // --- Row 2: Capacity ---
      {
        id: 5,
        title: "Disk Usage",
        type: "gauge",
        gridPos: { h: 8, w: 8, x: 0, y: 4 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `minio_node_drive_used_bytes / minio_node_drive_total_bytes`,
            refId: "A",
            legendFormat: "{{drive}}",
          },
        ],
        fieldConfig: {
          defaults: {
            unit: "percentunit",
            min: 0,
            max: 1,
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
        id: 6,
        title: "Capacity (Raw)",
        type: "timeseries",
        gridPos: { h: 8, w: 8, x: 8, y: 4 },
        datasource: PROM_DS,
        targets: [
          { expr: `minio_cluster_capacity_raw_total_bytes`, refId: "A", legendFormat: "total" },
          { expr: `minio_cluster_capacity_raw_free_bytes`, refId: "B", legendFormat: "free" },
        ],
        fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
      },
      {
        id: 7,
        title: "Process Memory",
        type: "timeseries",
        gridPos: { h: 8, w: 8, x: 16, y: 4 },
        datasource: PROM_DS,
        targets: [
          { expr: `minio_node_process_resident_memory_bytes`, refId: "A", legendFormat: "RSS" },
        ],
        fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
      },
      // --- Row 3: S3 API ---
      {
        id: 8,
        title: "S3 Incoming Requests",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 12 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `rate(minio_s3_requests_incoming_total[5m])`,
            refId: "A",
            legendFormat: "incoming/s",
          },
        ],
        fieldConfig: { defaults: { unit: "reqps" }, overrides: [] },
      },
      {
        id: 9,
        title: "S3 Rejected Requests",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 12 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `rate(minio_s3_requests_rejected_auth_total[5m])`,
            refId: "A",
            legendFormat: "auth rejected/s",
          },
          {
            expr: `rate(minio_s3_requests_rejected_invalid_total[5m])`,
            refId: "B",
            legendFormat: "invalid/s",
          },
          {
            expr: `rate(minio_s3_requests_rejected_header_total[5m])`,
            refId: "C",
            legendFormat: "bad header/s",
          },
        ],
        fieldConfig: {
          defaults: { unit: "reqps", color: { mode: "fixed", fixedColor: "red" } },
          overrides: [],
        },
      },
      // --- Row 4: Traffic ---
      {
        id: 10,
        title: "S3 Traffic",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 20 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `rate(minio_s3_traffic_received_bytes[5m])`,
            refId: "A",
            legendFormat: "received",
          },
          { expr: `rate(minio_s3_traffic_sent_bytes[5m])`, refId: "B", legendFormat: "sent" },
        ],
        fieldConfig: { defaults: { unit: "Bps" }, overrides: [] },
      },
      {
        id: 11,
        title: "Drive Latency",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 20 },
        datasource: PROM_DS,
        targets: [
          { expr: `minio_node_drive_latency_us`, refId: "A", legendFormat: "{{api}} {{drive}}" },
        ],
        fieldConfig: { defaults: { unit: "\u00b5s" }, overrides: [] },
      },
      // --- Row 5: Node ---
      {
        id: 12,
        title: "Uptime",
        type: "stat",
        gridPos: { h: 4, w: 8, x: 0, y: 28 },
        datasource: PROM_DS,
        targets: [{ expr: `minio_node_process_uptime_seconds`, refId: "A" }],
        fieldConfig: { defaults: { unit: "s" }, overrides: [] },
      },
      {
        id: 13,
        title: "Go Routines",
        type: "stat",
        gridPos: { h: 4, w: 8, x: 8, y: 28 },
        datasource: PROM_DS,
        targets: [{ expr: `minio_node_go_routine_total`, refId: "A" }],
        fieldConfig: {
          defaults: {
            thresholds: {
              steps: [
                { color: "green", value: 0 },
                { color: "yellow", value: 500 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 14,
        title: "File Descriptors",
        type: "gauge",
        gridPos: { h: 4, w: 8, x: 16, y: 28 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `minio_node_file_descriptor_open_total / minio_node_file_descriptor_limit_total`,
            refId: "A",
          },
        ],
        fieldConfig: {
          defaults: {
            unit: "percentunit",
            min: 0,
            max: 1,
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
      // --- PVC Disk Usage ---
      ...pvcDiskUsagePanels(`persistentvolumeclaim=~"data.*minio.*"`, 15, 32),
    ],
    schemaVersion: 39,
    version: 1,
  };
}
