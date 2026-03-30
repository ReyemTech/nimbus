/**
 * Per-cluster CNPG PostgreSQL Grafana dashboard — created once per cluster
 * with metrics filtered by the cluster name.
 *
 * @module observability/dashboards/cnpg-cluster
 */

import type * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import { PROM_DS, createDashboardConfigMap, pvcDiskUsagePanels } from "./_helpers";

/** Build the per-cluster CNPG dashboard JSON filtered to a specific cluster. */
function cnpgClusterDashboard(clusterName: string): Record<string, unknown> {
  // Collector metrics use `cluster` label, pg_stat metrics use `pod` label
  const fc = `cluster="${clusterName}"`;
  const fp = `pod=~"${clusterName}-.*"`;
  return {
    uid: `nimbus-cnpg-${clusterName}`,
    title: `Nimbus / Data / Postgres / ${clusterName}`,
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
            expr: `cnpg_collector_up{${fc}}`,
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
            expr: `count(cnpg_collector_up{${fc}})`,
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
            expr: `cnpg_pg_replication_streaming_replicas{${fc}}`,
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
            expr: `cnpg_pg_stat_archiver_failed_count{${fc}}`,
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
            expr: `cnpg_backends_total{${fp}}`,
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
            expr: `cnpg_backends_waiting_total{${fp}}`,
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
            expr: `rate(cnpg_pg_stat_database_xact_commit{${fp}}[5m])`,
            refId: "A",
            legendFormat: "{{datname}} commits/s",
          },
          {
            expr: `rate(cnpg_pg_stat_database_xact_rollback{${fp}}[5m])`,
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
            expr: `cnpg_pg_replication_lag{${fc}}`,
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
            expr: `rate(cnpg_pg_stat_archiver_archived_count{${fc}}[5m])`,
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
            expr: `time() - cnpg_collector_last_available_backup_timestamp{${fc}}`,
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
            expr: `sum(cnpg_cache_hits{${fp}}) / (sum(cnpg_cache_hits{${fp}}) + sum(cnpg_cache_miss{${fp}}))`,
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
            expr: `rate(cnpg_pg_stat_user_tables_n_tup_ins{${fp}}[5m])`,
            refId: "A",
            legendFormat: "inserts/s",
          },
          {
            expr: `rate(cnpg_pg_stat_user_tables_n_tup_upd{${fp}}[5m])`,
            refId: "B",
            legendFormat: "updates/s",
          },
          {
            expr: `rate(cnpg_pg_stat_user_tables_n_tup_del{${fp}}[5m])`,
            refId: "C",
            legendFormat: "deletes/s",
          },
          {
            expr: `rate(cnpg_pg_stat_user_tables_n_tup_fetched{${fp}}[5m])`,
            refId: "D",
            legendFormat: "fetched/s",
          },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      // --- Database-level panels ---
      {
        id: 13,
        title: "Database Sizes",
        type: "bargauge",
        gridPos: { h: 8, w: 12, x: 0, y: 36 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `cnpg_pg_database_size_bytes{${fp}}`,
            refId: "A",
            legendFormat: "{{datname}}",
            instant: true,
          },
        ],
        fieldConfig: {
          defaults: {
            unit: "bytes",
            thresholds: {
              steps: [
                { value: 0, color: "green" },
                { value: 1073741824, color: "yellow" },
                { value: 10737418240, color: "red" },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 14,
        title: "Transactions by Database",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 36 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `rate(cnpg_pg_stat_database_xact_commit{${fp}}[5m])`,
            refId: "A",
            legendFormat: "{{datname}} commits/s",
          },
          {
            expr: `rate(cnpg_pg_stat_database_xact_rollback{${fp}}[5m])`,
            refId: "B",
            legendFormat: "{{datname}} rollbacks/s",
          },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 15,
        title: "Temp Files by Database",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 44 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `rate(cnpg_pg_stat_database_temp_bytes{${fp}}[5m])`,
            refId: "A",
            legendFormat: "{{datname}}",
          },
        ],
        fieldConfig: { defaults: { unit: "Bps" }, overrides: [] },
      },
      {
        id: 16,
        title: "Deadlocks & Conflicts by Database",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 44 },
        datasource: PROM_DS,
        targets: [
          {
            expr: `rate(cnpg_pg_stat_database_deadlocks{${fp}}[5m])`,
            refId: "A",
            legendFormat: "{{datname}} deadlocks",
          },
          {
            expr: `rate(cnpg_pg_stat_database_conflicts{${fp}}[5m])`,
            refId: "B",
            legendFormat: "{{datname}} conflicts",
          },
        ],
        fieldConfig: { defaults: { color: { mode: "fixed", fixedColor: "red" } }, overrides: [] },
      },
      // --- PVC Disk Usage ---
      ...pvcDiskUsagePanels(`persistentvolumeclaim=~"${clusterName}-.*"`, 17, 52),
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
