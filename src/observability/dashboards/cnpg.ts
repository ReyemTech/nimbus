/**
 * CloudNativePG overview Grafana dashboard — active backends, database sizes,
 * replication lag, cache hit ratio, transaction rate, WAL archival, backup age,
 * and deadlocks across all CNPG clusters.
 *
 * @module observability/dashboards/cnpg
 */

import { PROM_DS } from "./_helpers";

/** Grafana dashboard JSON for CNPG PostgreSQL overview (8 panels). */
export function cnpgDashboard(): Record<string, unknown> {
  return {
    uid: "nimbus-cnpg",
    title: "Nimbus / CNPG PostgreSQL",
    tags: ["nimbus", "cnpg", "postgresql"],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    refresh: "30s",
    panels: [
      {
        id: 1,
        title: "Total Active Backends",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'sum by (cluster) (label_replace(cnpg_backends_total, "cluster", "$1", "pod", "(.*)-\\\\d+"))',
            refId: "A",
            legendFormat: "{{cluster}}",
          },
        ],
      },
      {
        id: 2,
        title: "Database Sizes",
        type: "bargauge",
        gridPos: { h: 8, w: 12, x: 12, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "cnpg_pg_database_size_bytes",
            refId: "A",
            legendFormat: "{{datname}}",
          },
        ],
        fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
        options: { orientation: "horizontal", displayMode: "gradient" },
      },
      {
        id: 3,
        title: "Replication Lag",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 8 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "cnpg_pg_replication_lag",
            refId: "A",
            legendFormat: "{{cluster}}",
          },
        ],
        fieldConfig: { defaults: { unit: "s" }, overrides: [] },
      },
      {
        id: 4,
        title: "Cache Hit Ratio",
        type: "gauge",
        gridPos: { h: 8, w: 12, x: 12, y: 8 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "sum(cnpg_cache_hits) / (sum(cnpg_cache_hits) + sum(cnpg_cache_miss))",
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
        id: 5,
        title: "Transaction Rate",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 16 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'sum by (cluster) (label_replace(rate(cnpg_pg_stat_database_xact_commit[5m]), "cluster", "$1", "pod", "(.*)-\\\\d+"))',
            refId: "A",
            legendFormat: "{{cluster}} commits/s",
          },
          {
            expr: 'sum by (cluster) (label_replace(rate(cnpg_pg_stat_database_xact_rollback[5m]), "cluster", "$1", "pod", "(.*)-\\\\d+"))',
            refId: "B",
            legendFormat: "{{cluster}} rollbacks/s",
          },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 6,
        title: "WAL Archival",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 16 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "rate(cnpg_pg_stat_archiver_archived_count[5m])",
            refId: "A",
            legendFormat: "{{cluster}}",
          },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 7,
        title: "Last Backup Age",
        type: "stat",
        gridPos: { h: 8, w: 12, x: 0, y: 24 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "time() - cnpg_collector_last_available_backup_timestamp",
            refId: "A",
            legendFormat: "{{cluster}}",
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
        id: 8,
        title: "Deadlocks",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 24 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "rate(cnpg_pg_stat_database_deadlocks[5m])",
            refId: "A",
            legendFormat: "{{cluster}}",
          },
        ],
        fieldConfig: {
          defaults: { color: { mode: "fixed", fixedColor: "red" } },
          overrides: [],
        },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}
