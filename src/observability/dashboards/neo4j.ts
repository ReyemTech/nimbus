/**
 * Neo4j overview Grafana dashboard — combines Cypher-based panels
 * (works on Community) with Prometheus metrics (Enterprise).
 *
 * @module observability/dashboards/neo4j
 */

import { PROM_DS } from "./_helpers";

const NEO4J_DS = { type: "kniepdennis-neo4j-datasource", uid: "neo4j" };

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
      // --- Row 1: Cypher-based stats (works on Community) ---
      {
        id: 1,
        title: "Total Nodes",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 0, y: 0 },
        datasource: NEO4J_DS,
        targets: [
          { rawQuery: true, query: "MATCH (n) RETURN count(n) AS nodes", refId: "A" },
        ],
        fieldConfig: { defaults: { thresholds: { steps: [{ color: "blue", value: 0 }] } }, overrides: [] },
      },
      {
        id: 2,
        title: "Total Relationships",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 6, y: 0 },
        datasource: NEO4J_DS,
        targets: [
          { rawQuery: true, query: "MATCH ()-[r]->() RETURN count(r) AS relationships", refId: "A" },
        ],
        fieldConfig: { defaults: { thresholds: { steps: [{ color: "purple", value: 0 }] } }, overrides: [] },
      },
      {
        id: 3,
        title: "Active Transactions",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 12, y: 0 },
        datasource: NEO4J_DS,
        targets: [
          { rawQuery: true, query: "SHOW TRANSACTIONS YIELD transactionId RETURN count(transactionId) AS active", refId: "A" },
        ],
        fieldConfig: { defaults: { thresholds: { steps: [{ color: "green", value: 0 }, { color: "yellow", value: 10 }, { color: "red", value: 50 }] } }, overrides: [] },
      },
      {
        id: 4,
        title: "Databases",
        type: "table",
        gridPos: { h: 4, w: 6, x: 18, y: 0 },
        datasource: NEO4J_DS,
        targets: [
          { rawQuery: true, query: "SHOW DATABASES YIELD name, currentStatus, role RETURN name, currentStatus, role", refId: "A" },
        ],
      },
      // --- Row 2: Label & Relationship type distribution ---
      {
        id: 5,
        title: "Nodes by Label",
        type: "piechart",
        gridPos: { h: 8, w: 12, x: 0, y: 4 },
        datasource: NEO4J_DS,
        targets: [
          { rawQuery: true, query: "CALL db.labels() YIELD label CALL { WITH label MATCH (n) WHERE label IN labels(n) RETURN count(n) AS count } RETURN label, count ORDER BY count DESC LIMIT 15", refId: "A" },
        ],
      },
      {
        id: 6,
        title: "Relationship Types",
        type: "piechart",
        gridPos: { h: 8, w: 12, x: 12, y: 4 },
        datasource: NEO4J_DS,
        targets: [
          { rawQuery: true, query: "CALL db.relationshipTypes() YIELD relationshipType AS type CALL { WITH type MATCH ()-[r]->() WHERE type(r) = type RETURN count(r) AS count } RETURN type, count ORDER BY count DESC LIMIT 15", refId: "A" },
        ],
      },
      // --- Row 3: Prometheus metrics (Enterprise) ---
      {
        id: 7,
        title: "Transactions (Prometheus)",
        description: "Enterprise metrics — activates on Enterprise Edition",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 12 },
        datasource: PROM_DS,
        targets: [
          { expr: `rate(neo4j_database_transaction_committed_total[5m])`, refId: "A", legendFormat: "{{database}} committed/s" },
          { expr: `rate(neo4j_database_transaction_rollbacks_total[5m])`, refId: "B", legendFormat: "{{database}} rollbacks/s" },
        ],
        fieldConfig: { defaults: { unit: "ops", noValue: "Enterprise metrics not available" }, overrides: [] },
      },
      {
        id: 8,
        title: "GC Pause Time (Prometheus)",
        description: "Enterprise metrics — activates on Enterprise Edition",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 12 },
        datasource: PROM_DS,
        targets: [
          { expr: `rate(neo4j_vm_gc_time_total[5m])`, refId: "A", legendFormat: "{{gc}}" },
        ],
        fieldConfig: { defaults: { unit: "ms", noValue: "Enterprise metrics not available" }, overrides: [] },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}
