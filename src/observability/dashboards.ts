/**
 * Grafana dashboards and ServiceMonitors for Nimbus observability components.
 *
 * All dashboards are provisioned under a "Nimbus" Grafana folder via sidecar
 * annotations. ServiceMonitors and PodMonitors enable Prometheus scraping of
 * component metrics.
 *
 * @module observability/dashboards
 */

import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";

interface DashboardsConfig {
  namespace: string;
  provider: k8s.Provider;
  dependsOn: pulumi.Resource[];
}

/** Shared labels and annotations for all Nimbus dashboards. */
const FOLDER_LABEL = { grafana_dashboard: "1" };
const FOLDER_ANNOTATION = { grafana_folder: "Nimbus" };

/**
 * Create all Nimbus ServiceMonitors, PodMonitors, and Grafana dashboard ConfigMaps.
 *
 * @param name - Stack name prefix
 * @param config - Namespace, provider, and dependency info
 */
export function createDashboards(name: string, config: DashboardsConfig): void {
  const { namespace, provider, dependsOn } = config;

  // --- ServiceMonitors ---

  // Cert-manager (metrics on port 9402 in cert-manager namespace)
  new k8s.apiextensions.CustomResource(`${name}-sm-cert-manager`, {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: { name: "cert-manager", namespace, labels: { release: name } },
    spec: {
      namespaceSelector: { matchNames: ["cert-manager"] },
      selector: { matchLabels: { "app.kubernetes.io/name": "cert-manager" } },
      endpoints: [{ port: "tcp-prometheus-servicemonitor", interval: "30s" }],
    },
  }, { provider, dependsOn });

  // Redis exporter (metrics on port 9121 in data namespace)
  new k8s.apiextensions.CustomResource(`${name}-sm-redis`, {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "ServiceMonitor",
    metadata: { name: "redis-metrics", namespace, labels: { release: name } },
    spec: {
      namespaceSelector: { matchNames: ["data"] },
      selector: { matchLabels: { "app.kubernetes.io/name": "redis" } },
      endpoints: [{ port: "http-metrics", interval: "30s" }],
    },
  }, { provider, dependsOn });

  // CNPG PostgreSQL (PodMonitor — pods expose metrics directly on port 9187)
  new k8s.apiextensions.CustomResource(`${name}-pm-cnpg`, {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "PodMonitor",
    metadata: { name: "cnpg-clusters", namespace, labels: { release: name } },
    spec: {
      namespaceSelector: { matchNames: ["data"] },
      selector: { matchExpressions: [{ key: "cnpg.io/cluster", operator: "Exists" }] },
      podMetricsEndpoints: [{ port: "metrics" }],
    },
  }, { provider, dependsOn });

  // NOTE: Traefik ServiceMonitor requires `ports.metrics.expose.default: true`
  // in the Traefik Helm values (platform stack). The dashboard is provisioned
  // here but metrics won't flow until that value is set.

  // --- Dashboard ConfigMaps ---

  createDashboardConfigMap(name, "cert-manager", certManagerDashboard(), namespace, provider, dependsOn);
  createDashboardConfigMap(name, "redis", redisDashboard(), namespace, provider, dependsOn);
  createDashboardConfigMap(name, "cnpg", cnpgDashboard(), namespace, provider, dependsOn);
  createDashboardConfigMap(name, "traefik-ingress", traefikDashboard(), namespace, provider, dependsOn);
}

function createDashboardConfigMap(
  name: string,
  dashName: string,
  json: Record<string, unknown>,
  namespace: string,
  provider: k8s.Provider,
  dependsOn: pulumi.Resource[],
): void {
  new k8s.core.v1.ConfigMap(`${name}-dashboard-${dashName}`, {
    metadata: {
      name: `${name}-${dashName}-dashboard`,
      namespace,
      labels: FOLDER_LABEL,
      annotations: FOLDER_ANNOTATION,
    },
    data: { [`${dashName}.json`]: JSON.stringify(json) },
  }, { provider, dependsOn });
}

// ---------------------------------------------------------------------------
// Dashboard JSON generators
// ---------------------------------------------------------------------------

/** Grafana dashboard JSON for the Loki Logs Explorer. */
export function lokiLogsDashboard(): Record<string, unknown> {
  return {
    uid: "loki-logs-explorer",
    title: "Nimbus: Loki Logs Explorer",
    tags: ["nimbus", "loki", "logs"],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    templating: {
      list: [
        {
          name: "namespace",
          type: "query",
          datasource: { type: "loki", uid: "loki" },
          query: { label: "namespace", refId: "A", stream: "", type: 1 },
          refresh: 2,
          sort: 1,
          includeAll: true,
          current: { text: "All", value: "$__all" },
        },
        {
          name: "pod",
          type: "query",
          datasource: { type: "loki", uid: "loki" },
          query: { label: "pod", refId: "A", stream: '{namespace=~"$namespace"}', type: 1 },
          refresh: 2,
          sort: 1,
          includeAll: true,
          current: { text: "All", value: "$__all" },
        },
        {
          name: "container",
          type: "query",
          datasource: { type: "loki", uid: "loki" },
          query: {
            label: "container",
            refId: "A",
            stream: '{namespace=~"$namespace", pod=~"$pod"}',
            type: 1,
          },
          refresh: 2,
          sort: 1,
          includeAll: true,
          current: { text: "All", value: "$__all" },
        },
        {
          name: "search",
          type: "textbox",
          current: { text: "", value: "" },
        },
      ],
    },
    panels: [
      {
        id: 1,
        title: "Log Volume",
        type: "timeseries",
        gridPos: { h: 6, w: 24, x: 0, y: 0 },
        datasource: { type: "loki", uid: "loki" },
        targets: [
          {
            expr: 'sum(count_over_time({namespace=~"$namespace", pod=~"$pod", container=~"$container"} |~ "$search" [1m])) by (namespace)',
            refId: "A",
            legendFormat: "{{namespace}}",
          },
        ],
        fieldConfig: {
          defaults: {
            custom: { drawStyle: "bars", fillOpacity: 30, stacking: { mode: "normal" } },
          },
          overrides: [],
        },
      },
      {
        id: 2,
        title: "Logs",
        type: "logs",
        gridPos: { h: 20, w: 24, x: 0, y: 6 },
        datasource: { type: "loki", uid: "loki" },
        targets: [
          {
            expr: '{namespace=~"$namespace", pod=~"$pod", container=~"$container"} |~ "$search"',
            refId: "A",
          },
        ],
        options: {
          showTime: true,
          showLabels: true,
          showCommonLabels: false,
          wrapLogMessage: true,
          prettifyLogMessage: false,
          enableLogDetails: true,
          sortOrder: "Descending",
          dedupStrategy: "none",
        },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}

/** Prometheus datasource reference for dashboard panels. */
const PROM_DS = { type: "prometheus", uid: "prometheus" };

/** Grafana dashboard for cert-manager certificate monitoring. */
function certManagerDashboard(): Record<string, unknown> {
  return {
    uid: "nimbus-cert-manager",
    title: "Nimbus: Cert-Manager",
    tags: ["nimbus", "cert-manager"],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    panels: [
      {
        id: 1,
        title: "Certificates Ready",
        type: "stat",
        gridPos: { h: 6, w: 8, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [{
          expr: 'sum(certmanager_certificate_ready_status{condition="True"})',
          refId: "A",
          legendFormat: "Ready",
        }],
        fieldConfig: { defaults: { thresholds: { steps: [{ color: "green", value: 0 }] } }, overrides: [] },
      },
      {
        id: 2,
        title: "Certificates Not Ready",
        type: "stat",
        gridPos: { h: 6, w: 8, x: 8, y: 0 },
        datasource: PROM_DS,
        targets: [{
          expr: 'sum(certmanager_certificate_ready_status{condition="False"})',
          refId: "A",
          legendFormat: "Not Ready",
        }],
        fieldConfig: { defaults: { thresholds: { steps: [{ color: "green", value: 0 }, { color: "red", value: 1 }] } }, overrides: [] },
      },
      {
        id: 3,
        title: "Certificate Expiry (days)",
        type: "table",
        gridPos: { h: 6, w: 8, x: 16, y: 0 },
        datasource: PROM_DS,
        targets: [{
          expr: "(certmanager_certificate_expiration_timestamp_seconds - time()) / 86400",
          refId: "A",
          legendFormat: "{{name}}",
          instant: true,
          format: "table",
        }],
        fieldConfig: {
          defaults: { thresholds: { steps: [{ color: "red", value: 0 }, { color: "yellow", value: 7 }, { color: "green", value: 30 }] } },
          overrides: [],
        },
      },
      {
        id: 4,
        title: "ACME Requests Rate",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 6 },
        datasource: PROM_DS,
        targets: [{
          expr: "sum(rate(certmanager_http_acme_client_request_count[5m])) by (status)",
          refId: "A",
          legendFormat: "{{status}}",
        }],
      },
      {
        id: 5,
        title: "Certificate Expiry Timeline",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 6 },
        datasource: PROM_DS,
        targets: [{
          expr: "certmanager_certificate_expiration_timestamp_seconds",
          refId: "A",
          legendFormat: "{{name}} ({{namespace}})",
        }],
        fieldConfig: { defaults: { unit: "dateTimeFromNow" }, overrides: [] },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}

/** Grafana dashboard for Redis metrics. */
function redisDashboard(): Record<string, unknown> {
  return {
    uid: "nimbus-redis",
    title: "Nimbus: Redis",
    tags: ["nimbus", "redis"],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    panels: [
      {
        id: 1,
        title: "Memory Usage",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [
          { expr: "redis_memory_used_bytes", refId: "A", legendFormat: "Used" },
          { expr: "redis_memory_max_bytes", refId: "B", legendFormat: "Max" },
        ],
        fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
      },
      {
        id: 2,
        title: "Hit/Miss Ratio",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 0 },
        datasource: PROM_DS,
        targets: [
          { expr: "rate(redis_keyspace_hits_total[5m])", refId: "A", legendFormat: "Hits/s" },
          { expr: "rate(redis_keyspace_misses_total[5m])", refId: "B", legendFormat: "Misses/s" },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 3,
        title: "Connected Clients",
        type: "stat",
        gridPos: { h: 6, w: 8, x: 0, y: 8 },
        datasource: PROM_DS,
        targets: [{ expr: "redis_connected_clients", refId: "A", legendFormat: "Clients" }],
      },
      {
        id: 4,
        title: "Commands/sec",
        type: "timeseries",
        gridPos: { h: 6, w: 8, x: 8, y: 8 },
        datasource: PROM_DS,
        targets: [{ expr: "rate(redis_commands_processed_total[5m])", refId: "A", legendFormat: "cmd/s" }],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 5,
        title: "Keyspace Keys",
        type: "stat",
        gridPos: { h: 6, w: 8, x: 16, y: 8 },
        datasource: PROM_DS,
        targets: [{ expr: "sum(redis_db_keys)", refId: "A", legendFormat: "Total Keys" }],
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}

/** Grafana dashboard for CloudNativePG PostgreSQL clusters. */
function cnpgDashboard(): Record<string, unknown> {
  return {
    uid: "nimbus-cnpg",
    title: "Nimbus: CNPG PostgreSQL",
    tags: ["nimbus", "cnpg", "postgresql"],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    panels: [
      {
        id: 1,
        title: "Active Connections",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [{
          expr: 'cnpg_pg_stat_activity_count{state="active"}',
          refId: "A",
          legendFormat: "{{pod}}",
        }],
      },
      {
        id: 2,
        title: "Replication Lag",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 0 },
        datasource: PROM_DS,
        targets: [{
          expr: "cnpg_pg_replication_lag",
          refId: "A",
          legendFormat: "{{pod}}",
        }],
        fieldConfig: { defaults: { unit: "s" }, overrides: [] },
      },
      {
        id: 3,
        title: "Transaction Rate",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 8 },
        datasource: PROM_DS,
        targets: [
          { expr: "rate(cnpg_pg_stat_database_xact_commit[5m])", refId: "A", legendFormat: "{{datname}} commits/s" },
          { expr: "rate(cnpg_pg_stat_database_xact_rollback[5m])", refId: "B", legendFormat: "{{datname}} rollbacks/s" },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 4,
        title: "Checkpoint Activity",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 8 },
        datasource: PROM_DS,
        targets: [{
          expr: "rate(cnpg_pg_stat_bgwriter_buffers_checkpoint[5m])",
          refId: "A",
          legendFormat: "{{pod}} buffers/s",
        }],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 5,
        title: "Database Size",
        type: "stat",
        gridPos: { h: 6, w: 12, x: 0, y: 16 },
        datasource: PROM_DS,
        targets: [{
          expr: "cnpg_pg_database_size_bytes",
          refId: "A",
          legendFormat: "{{datname}}",
        }],
        fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
      },
      {
        id: 6,
        title: "Collector Errors",
        type: "stat",
        gridPos: { h: 6, w: 12, x: 12, y: 16 },
        datasource: PROM_DS,
        targets: [{
          expr: "cnpg_collector_last_collection_error",
          refId: "A",
          legendFormat: "{{pod}}",
        }],
        fieldConfig: { defaults: { thresholds: { steps: [{ color: "green", value: 0 }, { color: "red", value: 1 }] } }, overrides: [] },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}

/** Grafana dashboard for Traefik ingress metrics. */
function traefikDashboard(): Record<string, unknown> {
  return {
    uid: "nimbus-traefik",
    title: "Nimbus: Traefik Ingress",
    tags: ["nimbus", "traefik"],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    panels: [
      {
        id: 1,
        title: "Request Rate by Service",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [{
          expr: "sum(rate(traefik_service_requests_total[5m])) by (service)",
          refId: "A",
          legendFormat: "{{service}}",
        }],
        fieldConfig: { defaults: { unit: "reqps" }, overrides: [] },
      },
      {
        id: 2,
        title: "Latency p50 / p95 / p99",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 0 },
        datasource: PROM_DS,
        targets: [
          { expr: "histogram_quantile(0.50, sum(rate(traefik_service_request_duration_seconds_bucket[5m])) by (le))", refId: "A", legendFormat: "p50" },
          { expr: "histogram_quantile(0.95, sum(rate(traefik_service_request_duration_seconds_bucket[5m])) by (le))", refId: "B", legendFormat: "p95" },
          { expr: "histogram_quantile(0.99, sum(rate(traefik_service_request_duration_seconds_bucket[5m])) by (le))", refId: "C", legendFormat: "p99" },
        ],
        fieldConfig: { defaults: { unit: "s" }, overrides: [] },
      },
      {
        id: 3,
        title: "Error Rate (4xx / 5xx)",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 8 },
        datasource: PROM_DS,
        targets: [
          { expr: 'sum(rate(traefik_service_requests_total{code=~"4.."}[5m]))', refId: "A", legendFormat: "4xx" },
          { expr: 'sum(rate(traefik_service_requests_total{code=~"5.."}[5m]))', refId: "B", legendFormat: "5xx" },
        ],
        fieldConfig: { defaults: { unit: "reqps" }, overrides: [] },
      },
      {
        id: 4,
        title: "Active Connections",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 8 },
        datasource: PROM_DS,
        targets: [{
          expr: "sum(rate(traefik_entrypoint_requests_total[5m])) by (entrypoint)",
          refId: "A",
          legendFormat: "{{entrypoint}}",
        }],
        fieldConfig: { defaults: { unit: "reqps" }, overrides: [] },
      },
      {
        id: 5,
        title: "TLS Certificate Expiry",
        type: "table",
        gridPos: { h: 6, w: 24, x: 0, y: 16 },
        datasource: PROM_DS,
        targets: [{
          expr: "(traefik_tls_certs_not_after - time()) / 86400",
          refId: "A",
          legendFormat: "{{cn}}",
          instant: true,
          format: "table",
        }],
        fieldConfig: {
          defaults: {
            unit: "d",
            thresholds: { steps: [{ color: "red", value: 0 }, { color: "yellow", value: 7 }, { color: "green", value: 30 }] },
          },
          overrides: [],
        },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}
