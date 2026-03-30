/**
 * Neo4j overview Grafana dashboard — aggregate metrics across all Neo4j instances.
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
          {
            expr: `up{job=~".*neo4j.*"}`,
            refId: "A",
            legendFormat: "{{instance}}",
          },
        ],
        fieldConfig: {
          defaults: {
            mappings: [
              { type: "value", options: { "1": { text: "UP", color: "green" }, "0": { text: "DOWN", color: "red" } } },
            ],
          },
          overrides: [],
        },
      },
      {
        id: 2,
        title: "Store Size",
        type: "stat",
        gridPos: { h: 4, w: 8, x: 8, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `neo4j_database_store_size_total`,
            refId: "A",
            legendFormat: "{{database}}",
          },
        ],
        fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
      },
      {
        id: 3,
        title: "JVM Heap Used",
        type: "gauge",
        gridPos: { h: 4, w: 8, x: 16, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `neo4j_vm_memory_pool_bytes{pool="heap"} / neo4j_vm_memory_pool_bytes_max{pool="heap"}`,
            refId: "A",
            legendFormat: "heap usage",
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
        id: 4,
        title: "Transactions Committed",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 4 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `rate(neo4j_database_transaction_committed_total[5m])`,
            refId: "A",
            legendFormat: "{{database}} committed/s",
          },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 5,
        title: "Transactions Rolled Back",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 4 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `rate(neo4j_database_transaction_rollbacks_total[5m])`,
            refId: "A",
            legendFormat: "{{database}} rollbacks/s",
          },
        ],
        fieldConfig: { defaults: { unit: "ops", color: { mode: "fixed", fixedColor: "red" } }, overrides: [] },
      },
      {
        id: 6,
        title: "Bolt Connections",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 12 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `neo4j_bolt_connections_opened`,
            refId: "A",
            legendFormat: "open",
          },
          {
            expr: `neo4j_bolt_connections_closed`,
            refId: "B",
            legendFormat: "closed",
          },
        ],
      },
      {
        id: 7,
        title: "Page Cache Hit Ratio",
        type: "gauge",
        gridPos: { h: 8, w: 12, x: 12, y: 12 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `neo4j_page_cache_hit_ratio`,
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
    ],
    schemaVersion: 39,
    version: 1,
  };
}
