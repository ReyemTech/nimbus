/**
 * Per-cluster Neo4j Grafana dashboard — created once per Neo4j instance
 * with metrics from JMX Prometheus exporter filtered by instance.
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
        title: "JVM Heap Used",
        type: "gauge",
        gridPos: { h: 4, w: 6, x: 6, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `jvm_memory_HeapMemoryUsage_used{${fi}} / jvm_memory_HeapMemoryUsage_max{${fi}}`,
            refId: "A",
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
        id: 3,
        title: "Active Threads",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 12, y: 0 },
        datasource: PROM_DS,
        targets: [{ expr: `jvm_threading_ThreadCount{${fi}}`, refId: "A" }],
        fieldConfig: { defaults: { thresholds: { steps: [{ color: "blue", value: 0 }] } }, overrides: [] },
      },
      {
        id: 4,
        title: "Open File Descriptors",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 18, y: 0 },
        datasource: PROM_DS,
        targets: [{ expr: `jvm_os_OpenFileDescriptorCount{${fi}}`, refId: "A" }],
        fieldConfig: { defaults: { thresholds: { steps: [{ color: "green", value: 0 }, { color: "yellow", value: 500 }, { color: "red", value: 900 }] } }, overrides: [] },
      },
      // --- Row 2: JVM ---
      {
        id: 5,
        title: "JVM Heap Memory",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 4 },
        datasource: PROM_DS,
        targets: [
          { expr: `jvm_memory_HeapMemoryUsage_used{${fi}}`, refId: "A", legendFormat: "used" },
          { expr: `jvm_memory_HeapMemoryUsage_committed{${fi}}`, refId: "B", legendFormat: "committed" },
          { expr: `jvm_memory_HeapMemoryUsage_max{${fi}}`, refId: "C", legendFormat: "max" },
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
          { expr: `rate(jvm_gc_CollectionTime{${fi}}[5m])`, refId: "A", legendFormat: "{{gc}}" },
        ],
        fieldConfig: { defaults: { unit: "ms" }, overrides: [] },
      },
      // --- Row 3: Transactions & Bolt ---
      {
        id: 7,
        title: "Transactions",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 12 },
        datasource: PROM_DS,
        targets: [
          { expr: `rate(neo4j_transaction_committed_total{${fi}}[5m])`, refId: "A", legendFormat: "committed/s" },
          { expr: `rate(neo4j_transaction_rollbacks_total{${fi}}[5m])`, refId: "B", legendFormat: "rollbacks/s" },
          { expr: `neo4j_transaction_active{${fi}}`, refId: "C", legendFormat: "active" },
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
      // --- Row 4: Page Cache ---
      {
        id: 9,
        title: "Page Cache Hit Ratio",
        type: "gauge",
        gridPos: { h: 8, w: 12, x: 0, y: 20 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `neo4j_page_cache_hits_total{${fi}} / (neo4j_page_cache_hits_total{${fi}} + neo4j_page_cache_faults_total{${fi}})`,
            refId: "A",
          },
        ],
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
        title: "Page Cache Operations",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 20 },
        datasource: PROM_DS,
        targets: [
          { expr: `rate(neo4j_page_cache_hits_total{${fi}}[5m])`, refId: "A", legendFormat: "hits/s" },
          { expr: `rate(neo4j_page_cache_faults_total{${fi}}[5m])`, refId: "B", legendFormat: "faults/s" },
          { expr: `rate(neo4j_page_cache_evictions_total{${fi}}[5m])`, refId: "C", legendFormat: "evictions/s" },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      // --- Row 5: Checkpoints & Bolt messages ---
      {
        id: 11,
        title: "Checkpoint Events",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 28 },
        datasource: PROM_DS,
        targets: [
          { expr: `rate(neo4j_check_point_events_total{${fi}}[5m])`, refId: "A", legendFormat: "events/s" },
          { expr: `neo4j_check_point_total_time_total{${fi}}`, refId: "B", legendFormat: "total time ms" },
        ],
      },
      {
        id: 12,
        title: "Bolt Messages",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 28 },
        datasource: PROM_DS,
        targets: [
          { expr: `rate(neo4j_bolt_messages_received_total{${fi}}[5m])`, refId: "A", legendFormat: "received/s" },
          { expr: `rate(neo4j_bolt_messages_started_total{${fi}}[5m])`, refId: "B", legendFormat: "started/s" },
          { expr: `rate(neo4j_bolt_messages_done_total{${fi}}[5m])`, refId: "C", legendFormat: "done/s" },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}

/**
 * Create a per-cluster Neo4j dashboard ConfigMap.
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
