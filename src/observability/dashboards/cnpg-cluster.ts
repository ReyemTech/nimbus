/**
 * Per-cluster CNPG PostgreSQL Grafana dashboard — created once per cluster
 * with metrics filtered by the cluster name.
 *
 * @module observability/dashboards/cnpg-cluster
 */

import type * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import { PROM_DS, createDashboardConfigMap } from "./_helpers";

/** Build the per-cluster CNPG dashboard JSON filtered to a specific cluster. */
function cnpgClusterDashboard(clusterName: string): Record<string, unknown> {
  const f = `cnpg_cluster="${clusterName}"`;
  return {
    uid: `nimbus-cnpg-${clusterName}`,
    title: `Nimbus / Data / PostgreSQL / ${clusterName}`,
    tags: ["nimbus", "cnpg", "postgresql", clusterName],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    refresh: "30s",
    panels: [
      {
        id: 1,
        title: "Cluster Status",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `cnpg_collector_up{${f}}`,
            refId: "A",
            legendFormat: "up",
          },
        ],
        fieldConfig: {
          defaults: {
            mappings: [
              {
                type: "value",
                options: {
                  "1": { text: "UP", color: "green" },
                  "0": { text: "DOWN", color: "red" },
                },
              },
            ],
          },
          overrides: [],
        },
      },
      {
        id: 2,
        title: "Instances",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 6, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `count(cnpg_collector_up{${f}})`,
            refId: "A",
            legendFormat: "instances",
          },
        ],
        fieldConfig: {
          defaults: { thresholds: { steps: [{ color: "green", value: 0 }] } },
          overrides: [],
        },
      },
      {
        id: 3,
        title: "Streaming Replicas",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 12, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `cnpg_pg_replication_streaming_replicas{${f}}`,
            refId: "A",
            legendFormat: "replicas",
          },
        ],
        fieldConfig: {
          defaults: { thresholds: { steps: [{ color: "blue", value: 0 }] } },
          overrides: [],
        },
      },
      {
        id: 4,
        title: "WAL Failed",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 18, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `cnpg_pg_stat_archiver_failed_count{${f}}`,
            refId: "A",
            legendFormat: "failed",
          },
        ],
        fieldConfig: {
          defaults: {
            thresholds: {
              steps: [
                { color: "green", value: 0 },
                { color: "red", value: 1 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 5,
        title: "Active Backends",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 4 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `cnpg_backends_total{${f}}`,
            refId: "A",
            legendFormat: "{{pod}}",
          },
        ],
      },
      {
        id: 6,
        title: "Waiting Backends",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 4 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `cnpg_backends_waiting_total{${f}}`,
            refId: "A",
            legendFormat: "{{pod}}",
          },
        ],
      },
      {
        id: 7,
        title: "Transactions",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 12 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `rate(cnpg_pg_stat_database_xact_commit{${f}}[5m])`,
            refId: "A",
            legendFormat: "{{datname}} commits/s",
          },
          {
            expr: `rate(cnpg_pg_stat_database_xact_rollback{${f}}[5m])`,
            refId: "B",
            legendFormat: "{{datname}} rollbacks/s",
          },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 8,
        title: "Replication Lag",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 12 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `cnpg_pg_replication_lag{${f}}`,
            refId: "A",
            legendFormat: "{{pod}}",
          },
        ],
        fieldConfig: { defaults: { unit: "s" }, overrides: [] },
      },
      {
        id: 9,
        title: "WAL Archived",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 20 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `rate(cnpg_pg_stat_archiver_archived_count{${f}}[5m])`,
            refId: "A",
            legendFormat: "{{pod}}",
          },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 10,
        title: "Backup Age",
        type: "stat",
        gridPos: { h: 8, w: 12, x: 12, y: 20 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `time() - cnpg_collector_last_available_backup_timestamp{${f}}`,
            refId: "A",
            legendFormat: "age",
          },
        ],
        fieldConfig: {
          defaults: {
            unit: "s",
            thresholds: {
              steps: [
                { color: "green", value: 0 },
                { color: "yellow", value: 86400 },
                { color: "red", value: 172800 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 11,
        title: "Cache Hit Ratio",
        type: "gauge",
        gridPos: { h: 8, w: 12, x: 0, y: 28 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `sum(cnpg_cache_hits{${f}}) / (sum(cnpg_cache_hits{${f}}) + sum(cnpg_cache_miss{${f}}))`,
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
        id: 12,
        title: "Tuple Operations",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 28 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `rate(cnpg_pg_stat_user_tables_n_tup_ins{${f}}[5m])`,
            refId: "A",
            legendFormat: "inserts/s",
          },
          {
            expr: `rate(cnpg_pg_stat_user_tables_n_tup_upd{${f}}[5m])`,
            refId: "B",
            legendFormat: "updates/s",
          },
          {
            expr: `rate(cnpg_pg_stat_user_tables_n_tup_del{${f}}[5m])`,
            refId: "C",
            legendFormat: "deletes/s",
          },
          {
            expr: `rate(cnpg_pg_stat_user_tables_n_tup_fetched{${f}}[5m])`,
            refId: "D",
            legendFormat: "fetched/s",
          },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}

/**
 * Create a per-cluster CNPG PostgreSQL dashboard ConfigMap.
 *
 * Called from `operator/cnpg.ts` after creating each CNPG cluster.
 */
export function createCnpgClusterDashboard(
  clusterName: string,
  namespace: string,
  provider: k8s.Provider,
  dependsOn: pulumi.Resource[]
): void {
  createDashboardConfigMap(
    clusterName,
    `cnpg-${clusterName}`,
    cnpgClusterDashboard(clusterName),
    namespace,
    provider,
    dependsOn,
    "Nimbus / Data / PostgreSQL"
  );
}
