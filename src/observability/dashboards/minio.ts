/**
 * MinIO overview Grafana dashboard — S3 object storage metrics.
 *
 * MinIO exposes Prometheus metrics natively at /minio/v2/metrics/cluster
 * and /minio/v2/metrics/node endpoints.
 *
 * @module observability/dashboards/minio
 */

import { PROM_DS } from "./_helpers";

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
      // --- Row 1: Status ---
      {
        id: 1,
        title: "Instance Status",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [
          { expr: `minio_cluster_health_status`, refId: "A", legendFormat: "health" },
        ],
        fieldConfig: {
          defaults: {
            mappings: [{ type: "value", options: { "1": { text: "Healthy", color: "green" }, "0": { text: "Unhealthy", color: "red" } } }],
          },
          overrides: [],
        },
      },
      {
        id: 2,
        title: "Total Storage Used",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 6, y: 0 },
        datasource: PROM_DS,
        targets: [
          { expr: `minio_cluster_usage_total_bytes`, refId: "A", legendFormat: "used" },
        ],
        fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
      },
      {
        id: 3,
        title: "Total Objects",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 12, y: 0 },
        datasource: PROM_DS,
        targets: [
          { expr: `minio_cluster_usage_object_total`, refId: "A", legendFormat: "objects" },
        ],
        fieldConfig: { defaults: { thresholds: { steps: [{ color: "blue", value: 0 }] } }, overrides: [] },
      },
      {
        id: 4,
        title: "Total Buckets",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 18, y: 0 },
        datasource: PROM_DS,
        targets: [
          { expr: `minio_cluster_usage_buckets_total`, refId: "A", legendFormat: "buckets" },
        ],
        fieldConfig: { defaults: { thresholds: { steps: [{ color: "blue", value: 0 }] } }, overrides: [] },
      },
      // --- Row 2: S3 API ---
      {
        id: 5,
        title: "S3 API Request Rate",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 4 },
        datasource: PROM_DS,
        targets: [
          { expr: `rate(minio_s3_requests_total[5m])`, refId: "A", legendFormat: "{{api}} {{method}}" },
        ],
        fieldConfig: { defaults: { unit: "reqps" }, overrides: [] },
      },
      {
        id: 6,
        title: "S3 Error Rate",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 4 },
        datasource: PROM_DS,
        targets: [
          { expr: `rate(minio_s3_requests_errors_total[5m])`, refId: "A", legendFormat: "{{api}} errors/s" },
        ],
        fieldConfig: { defaults: { unit: "reqps", color: { mode: "fixed", fixedColor: "red" } }, overrides: [] },
      },
      // --- Row 3: Traffic ---
      {
        id: 7,
        title: "Network Traffic (Received)",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 12 },
        datasource: PROM_DS,
        targets: [
          { expr: `rate(minio_s3_traffic_received_bytes[5m])`, refId: "A", legendFormat: "received" },
        ],
        fieldConfig: { defaults: { unit: "Bps" }, overrides: [] },
      },
      {
        id: 8,
        title: "Network Traffic (Sent)",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 12 },
        datasource: PROM_DS,
        targets: [
          { expr: `rate(minio_s3_traffic_sent_bytes[5m])`, refId: "A", legendFormat: "sent" },
        ],
        fieldConfig: { defaults: { unit: "Bps" }, overrides: [] },
      },
      // --- Row 4: Bucket-level ---
      {
        id: 9,
        title: "Bucket Sizes",
        type: "bargauge",
        gridPos: { h: 8, w: 12, x: 0, y: 20 },
        datasource: PROM_DS,
        targets: [
          { expr: `minio_bucket_usage_total_bytes`, refId: "A", legendFormat: "{{bucket}}", instant: true },
        ],
        fieldConfig: {
          defaults: {
            unit: "bytes",
            thresholds: { steps: [{ value: 0, color: "green" }, { value: 1073741824, color: "yellow" }, { value: 10737418240, color: "red" }] },
          },
          overrides: [],
        },
      },
      {
        id: 10,
        title: "Bucket Object Count",
        type: "bargauge",
        gridPos: { h: 8, w: 12, x: 12, y: 20 },
        datasource: PROM_DS,
        targets: [
          { expr: `minio_bucket_usage_object_total`, refId: "A", legendFormat: "{{bucket}}", instant: true },
        ],
        fieldConfig: {
          defaults: { thresholds: { steps: [{ value: 0, color: "blue" }] } },
          overrides: [],
        },
      },
      // --- Row 5: Disk & Healing ---
      {
        id: 11,
        title: "Disk Usage",
        type: "gauge",
        gridPos: { h: 8, w: 12, x: 0, y: 28 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `minio_node_disk_used_bytes / minio_node_disk_total_bytes`,
            refId: "A", legendFormat: "disk usage",
          },
        ],
        fieldConfig: {
          defaults: {
            unit: "percentunit", min: 0, max: 1,
            thresholds: { steps: [{ color: "green", value: 0 }, { color: "yellow", value: 0.75 }, { color: "red", value: 0.9 }] },
          },
          overrides: [],
        },
      },
      {
        id: 12,
        title: "S3 Request Duration (p99)",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 28 },
        datasource: PROM_DS,
        targets: [
          { expr: `histogram_quantile(0.99, rate(minio_s3_requests_duration_seconds_bucket[5m]))`, refId: "A", legendFormat: "p99 latency" },
        ],
        fieldConfig: { defaults: { unit: "s" }, overrides: [] },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}
