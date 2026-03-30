/**
 * Neo4j overview Grafana dashboard — aggregate metrics across all Neo4j
 * instances via JMX Prometheus exporter.
 *
 * @module observability/dashboards/neo4j
 */

import { PROM_DS } from "./_helpers";

/** Build the Neo4j overview dashboard JSON. */
export function neo4jDashboard(): Record<string, unknown> {
  return {
    uid: "nimbus-neo4j-overview",
    title: "Nimbus / Data / Neo4j",
    tags: ["nimbus", "neo4j", "graph"],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    refresh: "30s",
    panels: [
      {
        id: 1,
        title: "Instance Status",
        type: "stat",
        gridPos: { h: 4, w: 8, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [
          { expr: `up{job=~".*neo4j.*"}`, refId: "A", legendFormat: "{{instance}}" },
        ],
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
        gridPos: { h: 4, w: 8, x: 8, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `jvm_memory_HeapMemoryUsage_used{job=~".*neo4j.*"} / jvm_memory_HeapMemoryUsage_max{job=~".*neo4j.*"}`,
            refId: "A",
            legendFormat: "heap",
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
        gridPos: { h: 4, w: 8, x: 16, y: 0 },
        datasource: PROM_DS,
        targets: [
          { expr: `jvm_threading_ThreadCount{job=~".*neo4j.*"}`, refId: "A", legendFormat: "threads" },
        ],
        fieldConfig: { defaults: { thresholds: { steps: [{ color: "blue", value: 0 }] } }, overrides: [] },
      },
      {
        id: 4,
        title: "Bolt Connections",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 4 },
        datasource: PROM_DS,
        targets: [
          { expr: `neo4j_bolt_connections_opened{job=~".*neo4j.*"}`, refId: "A", legendFormat: "opened" },
          { expr: `neo4j_bolt_connections_closed{job=~".*neo4j.*"}`, refId: "B", legendFormat: "closed" },
          { expr: `neo4j_bolt_connections_running{job=~".*neo4j.*"}`, refId: "C", legendFormat: "running" },
        ],
      },
      {
        id: 5,
        title: "Transactions",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 4 },
        datasource: PROM_DS,
        targets: [
          { expr: `rate(neo4j_transaction_committed_total{job=~".*neo4j.*"}[5m])`, refId: "A", legendFormat: "committed/s" },
          { expr: `rate(neo4j_transaction_rollbacks_total{job=~".*neo4j.*"}[5m])`, refId: "B", legendFormat: "rollbacks/s" },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 6,
        title: "Page Cache Hit Ratio",
        type: "gauge",
        gridPos: { h: 8, w: 12, x: 0, y: 12 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `neo4j_page_cache_hits_total{job=~".*neo4j.*"} / (neo4j_page_cache_hits_total{job=~".*neo4j.*"} + neo4j_page_cache_faults_total{job=~".*neo4j.*"})`,
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
        id: 7,
        title: "GC Pause Time",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 12 },
        datasource: PROM_DS,
        targets: [
          { expr: `rate(jvm_gc_CollectionTime{job=~".*neo4j.*"}[5m])`, refId: "A", legendFormat: "{{gc}}" },
        ],
        fieldConfig: { defaults: { unit: "ms" }, overrides: [] },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}
