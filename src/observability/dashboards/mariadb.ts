/**
 * MariaDB overview Grafana dashboard — connections, queries, slow queries,
 * InnoDB buffer pool, replication lag, aborted connections, binlog writes,
 * and table locks across all MariaDB instances.
 *
 * @module observability/dashboards/mariadb
 */

import { PROM_DS } from "./_helpers";

/** Grafana dashboard JSON for MariaDB overview (8 panels). */
export function mariadbDashboard(): Record<string, unknown> {
  return {
    uid: "nimbus-mariadb",
    title: "Nimbus / MariaDB",
    tags: ["nimbus", "mariadb"],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    refresh: "30s",
    panels: [
      {
        id: 1,
        title: "Connections",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "mysql_global_status_threads_connected",
            refId: "A",
            legendFormat: "{{instance}}",
          },
        ],
      },
      {
        id: 2,
        title: "Queries/sec",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "rate(mysql_global_status_queries[5m])",
            refId: "A",
            legendFormat: "{{instance}}",
          },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 3,
        title: "Slow Queries/min",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 8 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "rate(mysql_global_status_slow_queries[5m]) * 60",
            refId: "A",
            legendFormat: "{{instance}}",
          },
        ],
        fieldConfig: {
          defaults: { color: { mode: "fixed", fixedColor: "red" } },
          overrides: [],
        },
      },
      {
        id: 4,
        title: "InnoDB Buffer Pool",
        type: "gauge",
        gridPos: { h: 8, w: 6, x: 12, y: 8 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "mysql_global_status_innodb_buffer_pool_pages_data / mysql_global_status_innodb_buffer_pool_pages_total",
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
                { color: "green", value: 0 },
                { color: "yellow", value: 0.8 },
                { color: "red", value: 0.95 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 5,
        title: "Replication Lag",
        type: "stat",
        gridPos: { h: 8, w: 6, x: 18, y: 8 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "mysql_slave_status_seconds_behind_master",
            refId: "A",
            legendFormat: "{{instance}}",
          },
        ],
        fieldConfig: {
          defaults: {
            unit: "s",
            thresholds: {
              steps: [
                { color: "green", value: 0 },
                { color: "yellow", value: 5 },
                { color: "red", value: 30 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 6,
        title: "Aborted Connections",
        type: "timeseries",
        gridPos: { h: 8, w: 8, x: 0, y: 16 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "rate(mysql_global_status_aborted_connects[5m])",
            refId: "A",
            legendFormat: "{{instance}}",
          },
        ],
        fieldConfig: {
          defaults: { color: { mode: "fixed", fixedColor: "red" } },
          overrides: [],
        },
      },
      {
        id: 7,
        title: "Binlog Writes",
        type: "timeseries",
        gridPos: { h: 8, w: 8, x: 8, y: 16 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "rate(mysql_global_status_binlog_bytes_written[5m])",
            refId: "A",
            legendFormat: "{{instance}}",
          },
        ],
        fieldConfig: { defaults: { unit: "Bps" }, overrides: [] },
      },
      {
        id: 8,
        title: "Table Locks",
        type: "timeseries",
        gridPos: { h: 8, w: 8, x: 16, y: 16 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "rate(mysql_global_status_table_locks_waited[5m])",
            refId: "A",
            legendFormat: "{{instance}}",
          },
        ],
        fieldConfig: {
          defaults: { color: { mode: "fixed", fixedColor: "orange" } },
          overrides: [],
        },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}
