/**
 * Per-cluster Neo4j Grafana dashboard — created once per Neo4j instance
 * with metrics filtered by the instance name.
 *
 * @module observability/dashboards/neo4j-cluster
 */

import type * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import { PROM_DS, createDashboardConfigMap } from "./_helpers";

/** Build the per-cluster Neo4j dashboard JSON. */
function neo4jClusterDashboard(clusterName: string): Record<string, unknown> {
  const fi = `instance=~"${clusterName}.*"`;
  return {
    uid: `nimbus-neo4j-${clusterName}`,
    title: `Nimbus / Data / Neo4j / ${clusterName}`,
    tags: ["nimbus", "neo4j", "graph", clusterName],
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
        targets: [{ expr: `up{${fi}}`, refId: "A", legendFormat: "up" }],
        fieldConfig: {
          defaults: {
            mappings: [{ type: "value", options: { "1": { text: "UP", color: "green" }, "0": { text: "DOWN", color: "red" } } }],
          },
          overrides: [],
        },
      },
      {
        id: 2,
        title: "Store Size",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 6, y: 0 },
        datasource: PROM_DS,
        targets: [{ expr: `neo4j_database_store_size_total{${fi}}`, refId: "A", legendFormat: "{{database}}" }],
        fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
      },
      {
        id: 3,
        title: "Node Count",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 12, y: 0 },
        datasource: PROM_DS,
        targets: [{ expr: `neo4j_database_count_node{${fi}}`, refId: "A", legendFormat: "{{database}}" }],
        fieldConfig: { defaults: { thresholds: { steps: [{ color: "blue", value: 0 }] } }, overrides: [] },
      },
      {
        id: 4,
        title: "Relationship Count",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 18, y: 0 },
        datasource: PROM_DS,
        targets: [{ expr: `neo4j_database_count_relationship{${fi}}`, refId: "A", legendFormat: "{{database}}" }],
        fieldConfig: { defaults: { thresholds: { steps: [{ color: "blue", value: 0 }] } }, overrides: [] },
      },
      // --- Row 2: JVM ---
      {
        id: 5,
        title: "JVM Heap Usage",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 4 },
        datasource: PROM_DS,
        targets: [
          { expr: `neo4j_vm_memory_pool_bytes{${fi},pool="heap"}`, refId: "A", legendFormat: "used" },
          { expr: `neo4j_vm_memory_pool_bytes_max{${fi},pool="heap"}`, refId: "B", legendFormat: "max" },
        ],
        fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
      },
      {
        id: 6,
        title: "GC Pause Time",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 4 },
        datasource: PROM_DS,
        targets: [
          { expr: `rate(neo4j_vm_gc_time_total{${fi}}[5m])`, refId: "A", legendFormat: "{{gc}}" },
        ],
        fieldConfig: { defaults: { unit: "ms" }, overrides: [] },
      },
      // --- Row 3: Transactions & Queries ---
      {
        id: 7,
        title: "Transactions",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 12 },
        datasource: PROM_DS,
        targets: [
          { expr: `rate(neo4j_database_transaction_committed_total{${fi}}[5m])`, refId: "A", legendFormat: "committed/s" },
          { expr: `rate(neo4j_database_transaction_rollbacks_total{${fi}}[5m])`, refId: "B", legendFormat: "rollbacks/s" },
          { expr: `neo4j_database_transaction_active`, refId: "C", legendFormat: "active" },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 8,
        title: "Bolt Connections",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 12 },
        datasource: PROM_DS,
        targets: [
          { expr: `neo4j_bolt_connections_opened{${fi}}`, refId: "A", legendFormat: "opened" },
          { expr: `neo4j_bolt_connections_closed{${fi}}`, refId: "B", legendFormat: "closed" },
          { expr: `neo4j_bolt_connections_running{${fi}}`, refId: "C", legendFormat: "running" },
          { expr: `neo4j_bolt_connections_idle{${fi}}`, refId: "D", legendFormat: "idle" },
        ],
      },
      // --- Row 4: Page Cache & Disk ---
      {
        id: 9,
        title: "Page Cache Hit Ratio",
        type: "gauge",
        gridPos: { h: 8, w: 12, x: 0, y: 20 },
        datasource: PROM_DS,
        targets: [{ expr: `neo4j_page_cache_hit_ratio{${fi}}`, refId: "A" }],
        fieldConfig: {
          defaults: {
            unit: "percentunit", min: 0, max: 1,
            thresholds: { steps: [{ color: "red", value: 0 }, { color: "yellow", value: 0.9 }, { color: "green", value: 0.99 }] },
          },
          overrides: [],
        },
      },
      {
        id: 10,
        title: "Page Cache Pages",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 20 },
        datasource: PROM_DS,
        targets: [
          { expr: `rate(neo4j_page_cache_page_faults_total{${fi}}[5m])`, refId: "A", legendFormat: "faults/s" },
          { expr: `rate(neo4j_page_cache_evictions_total{${fi}}[5m])`, refId: "B", legendFormat: "evictions/s" },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      // --- Row 5: Checkpoint & Logs ---
      {
        id: 11,
        title: "Checkpoints",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 28 },
        datasource: PROM_DS,
        targets: [
          { expr: `rate(neo4j_check_point_events_total{${fi}}[5m])`, refId: "A", legendFormat: "events/s" },
          { expr: `neo4j_check_point_total_time_total{${fi}}`, refId: "B", legendFormat: "total time" },
        ],
        fieldConfig: { defaults: { unit: "ms" }, overrides: [] },
      },
      {
        id: 12,
        title: "Transaction Log Size",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 28 },
        datasource: PROM_DS,
        targets: [
          { expr: `neo4j_database_transaction_log_size{${fi}}`, refId: "A", legendFormat: "{{database}}" },
        ],
        fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}

/**
 * Create a per-cluster Neo4j dashboard ConfigMap.
 *
 * Called from `operator/neo4j.ts` after creating each Neo4j instance.
 */
export function createNeo4jClusterDashboard(
  clusterName: string,
  namespace: string,
  provider: k8s.Provider,
  dependsOn: pulumi.Resource[]
): void {
  createDashboardConfigMap(
    clusterName,
    `neo4j-${clusterName}`,
    neo4jClusterDashboard(clusterName),
    namespace,
    provider,
    dependsOn,
    "Nimbus / Data / Neo4j"
  );
}
