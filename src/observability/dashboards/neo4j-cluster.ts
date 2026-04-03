/**
 * Per-cluster Neo4j Grafana dashboard — combines Cypher-based panels
 * (via Neo4j datasource) with Prometheus metrics when available.
 *
 * On Community Edition, the Cypher panels provide node/relationship counts,
 * store info, and active transactions. Prometheus panels activate on Enterprise.
 *
 * @module observability/dashboards/neo4j-cluster
 */

import type * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import { PROM_DS, createDashboardConfigMap, pvcDiskUsagePanels } from "./_helpers";

const NEO4J_DS = { type: "kniepdennis-neo4j-datasource", uid: "neo4j" };

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
      // --- Row 1: Cypher-based stats (works on Community) ---
      {
        id: 1,
        title: "Node Count",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 0, y: 0 },
        datasource: NEO4J_DS,
        targets: [{ cypherQuery: "MATCH (n) RETURN count(n) AS nodes", refId: "A" }],
        fieldConfig: {
          defaults: { thresholds: { steps: [{ color: "blue", value: 0 }] } },
          overrides: [],
        },
      },
      {
        id: 2,
        title: "Relationship Count",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 6, y: 0 },
        datasource: NEO4J_DS,
        targets: [{ cypherQuery: "MATCH ()-[r]->() RETURN count(r) AS relationships", refId: "A" }],
        fieldConfig: {
          defaults: { thresholds: { steps: [{ color: "purple", value: 0 }] } },
          overrides: [],
        },
      },
      {
        id: 3,
        title: "Label Distribution",
        type: "bargauge",
        gridPos: { h: 4, w: 6, x: 12, y: 0 },
        datasource: NEO4J_DS,
        targets: [
          {
            cypherQuery:
              "CALL db.labels() YIELD label MATCH (n) WHERE label IN labels(n) RETURN label, count(n) AS count ORDER BY count DESC LIMIT 10",
            refId: "A",
          },
        ],
        fieldConfig: {
          defaults: { thresholds: { steps: [{ color: "green", value: 0 }] } },
          overrides: [],
        },
      },
      {
        id: 4,
        title: "Store Size",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 18, y: 0 },
        datasource: NEO4J_DS,
        targets: [
          {
            cypherQuery:
              "CALL dbms.queryJmx('org.neo4j:instance=kernel#0,name=Store sizes') YIELD attributes RETURN attributes['TotalStoreSize']['value'] AS bytes",
            refId: "A",
          },
        ],
        fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
      },
      // --- Row 2: Active transactions (Cypher) ---
      {
        id: 5,
        title: "Active Transactions",
        type: "stat",
        gridPos: { h: 4, w: 8, x: 0, y: 4 },
        datasource: NEO4J_DS,
        targets: [
          {
            cypherQuery:
              "SHOW TRANSACTIONS YIELD transactionId RETURN count(transactionId) AS active_transactions",
            refId: "A",
          },
        ],
        fieldConfig: {
          defaults: {
            thresholds: {
              steps: [
                { color: "green", value: 0 },
                { color: "yellow", value: 10 },
                { color: "red", value: 50 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 6,
        title: "Database Info",
        type: "table",
        gridPos: { h: 4, w: 16, x: 8, y: 4 },
        datasource: NEO4J_DS,
        targets: [
          {
            cypherQuery:
              "SHOW DATABASES YIELD name, currentStatus, role, store RETURN name, currentStatus, role, store",
            refId: "A",
          },
        ],
      },
      // --- Row 3: Prometheus metrics (Enterprise — shown when available) ---
      {
        id: 7,
        title: "Transactions (Prometheus)",
        description: "Enterprise metrics — shows data when Prometheus endpoint is active",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 8 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `rate(neo4j_database_transaction_committed_total{${fi}}[5m])`,
            refId: "A",
            legendFormat: "committed/s",
          },
          {
            expr: `rate(neo4j_database_transaction_rollbacks_total{${fi}}[5m])`,
            refId: "B",
            legendFormat: "rollbacks/s",
          },
        ],
        fieldConfig: {
          defaults: { unit: "ops", noValue: "Enterprise metrics not available" },
          overrides: [],
        },
      },
      {
        id: 8,
        title: "Bolt Connections (Prometheus)",
        description: "Enterprise metrics — shows data when Prometheus endpoint is active",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 8 },
        datasource: PROM_DS,
        targets: [
          { expr: `neo4j_bolt_connections_opened{${fi}}`, refId: "A", legendFormat: "opened" },
          { expr: `neo4j_bolt_connections_closed{${fi}}`, refId: "B", legendFormat: "closed" },
          { expr: `neo4j_bolt_connections_running{${fi}}`, refId: "C", legendFormat: "running" },
        ],
        fieldConfig: { defaults: { noValue: "Enterprise metrics not available" }, overrides: [] },
      },
      {
        id: 9,
        title: "Page Cache Hit Ratio (Prometheus)",
        description: "Enterprise metrics — shows data when Prometheus endpoint is active",
        type: "gauge",
        gridPos: { h: 8, w: 12, x: 0, y: 16 },
        datasource: PROM_DS,
        targets: [{ expr: `neo4j_page_cache_hit_ratio{${fi}}`, refId: "A" }],
        fieldConfig: {
          defaults: {
            unit: "percentunit",
            min: 0,
            max: 1,
            noValue: "Enterprise metrics not available",
            thresholds: {
              steps: [
                { color: "red", value: 0 },
                { color: "yellow", value: 0.9 },
                { color: "green", value: 0.99 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 10,
        title: "JVM Heap (Prometheus)",
        description: "Enterprise metrics — shows data when Prometheus endpoint is active",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 16 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `neo4j_vm_memory_pool_bytes{${fi},pool="heap"}`,
            refId: "A",
            legendFormat: "used",
          },
          {
            expr: `neo4j_vm_memory_pool_bytes_max{${fi},pool="heap"}`,
            refId: "B",
            legendFormat: "max",
          },
        ],
        fieldConfig: {
          defaults: { unit: "bytes", noValue: "Enterprise metrics not available" },
          overrides: [],
        },
      },
      // --- PVC Disk Usage ---
      ...pvcDiskUsagePanels(`persistentvolumeclaim=~"data-${clusterName}-.*"`, 11, 24),
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
