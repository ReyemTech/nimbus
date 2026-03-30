/**
 * Per-cluster MariaDB Grafana dashboard — created once per MariaDB instance
 * with metrics filtered via a template variable for the instance label.
 *
 * @module observability/dashboards/mariadb-cluster
 */

import type * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import { PROM_DS, createDashboardConfigMap } from "./_helpers";

/** Build the per-cluster MariaDB dashboard JSON with an instance template variable. */
function mariadbClusterDashboard(clusterName: string): Record<string, unknown> {
  return {
    uid: `nimbus-mariadb-${clusterName}`,
    title: `Nimbus / Data / MariaDB / ${clusterName}`,
    tags: ["nimbus", "mariadb", clusterName],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    refresh: "30s",
    templating: {
      list: [
        {
          name: "instance",
          type: "query",
          datasource: PROM_DS,
          query: "label_values(mysql_global_status_threads_connected, instance)",
          refresh: 2,
          sort: 1,
          includeAll: false,
          current: {},
        },
      ],
    },
    panels: [
      {
        id: 1,
        title: "Status",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'mysql_up{instance=~"$instance"}',
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
        title: "Connections",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 6, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'mysql_global_status_threads_connected{instance=~"$instance"}',
            refId: "A",
            legendFormat: "Connected",
          },
          {
            expr: 'mysql_global_status_threads_running{instance=~"$instance"}',
            refId: "B",
            legendFormat: "Running",
          },
          {
            expr: 'mysql_global_variables_max_connections{instance=~"$instance"}',
            refId: "C",
            legendFormat: "Max",
          },
        ],
      },
      {
        id: 3,
        title: "Replication Lag",
        type: "stat",
        gridPos: { h: 4, w: 6, x: 18, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'mysql_slave_status_seconds_behind_master{instance=~"$instance"}',
            refId: "A",
            legendFormat: "lag",
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
        id: 4,
        title: "Queries/sec",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 8 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'rate(mysql_global_status_queries{instance=~"$instance"}[5m])',
            refId: "A",
            legendFormat: "queries/s",
          },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 5,
        title: "Slow Queries",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 8 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'rate(mysql_global_status_slow_queries{instance=~"$instance"}[5m]) * 60',
            refId: "A",
            legendFormat: "slow/min",
          },
        ],
        fieldConfig: {
          defaults: { color: { mode: "fixed", fixedColor: "red" } },
          overrides: [],
        },
      },
      {
        id: 6,
        title: "InnoDB Buffer Pool Usage",
        type: "gauge",
        gridPos: { h: 8, w: 8, x: 0, y: 16 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'mysql_global_status_innodb_buffer_pool_pages_data{instance=~"$instance"} / mysql_global_status_innodb_buffer_pool_pages_total{instance=~"$instance"}',
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
        id: 7,
        title: "InnoDB Buffer Pool Hit Ratio",
        type: "gauge",
        gridPos: { h: 8, w: 8, x: 8, y: 16 },
        datasource: PROM_DS,
        targets: [
          {
            expr: '1 - (mysql_global_status_innodb_buffer_pool_reads{instance=~"$instance"} / mysql_global_status_innodb_buffer_pool_read_requests{instance=~"$instance"})',
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
        id: 8,
        title: "Binary Log",
        type: "timeseries",
        gridPos: { h: 8, w: 8, x: 16, y: 16 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'rate(mysql_global_status_binlog_bytes_written{instance=~"$instance"}[5m])',
            refId: "A",
            legendFormat: "bytes/s",
          },
        ],
        fieldConfig: { defaults: { unit: "Bps" }, overrides: [] },
      },
      {
        id: 9,
        title: "Aborted Clients / Connects",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 0, y: 24 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'rate(mysql_global_status_aborted_clients{instance=~"$instance"}[5m])',
            refId: "A",
            legendFormat: "Aborted Clients",
          },
          {
            expr: 'rate(mysql_global_status_aborted_connects{instance=~"$instance"}[5m])',
            refId: "B",
            legendFormat: "Aborted Connects",
          },
        ],
        fieldConfig: {
          defaults: { color: { mode: "fixed", fixedColor: "red" } },
          overrides: [],
        },
      },
      {
        id: 10,
        title: "Table Locks Waited",
        type: "timeseries",
        gridPos: { h: 8, w: 12, x: 12, y: 24 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'rate(mysql_global_status_table_locks_waited{instance=~"$instance"}[5m])',
            refId: "A",
            legendFormat: "locks waited/s",
          },
        ],
        fieldConfig: {
          defaults: { color: { mode: "fixed", fixedColor: "orange" } },
          overrides: [],
        },
      },
      // --- Storage & Table panels ---
      {
        id: 11,
        title: "Open Tables",
        type: "timeseries",
        gridPos: { h: 6, w: 8, x: 0, y: 30 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'mysql_global_status_open_tables{instance=~"$instance"}',
            refId: "A",
            legendFormat: "open",
          },
          {
            expr: 'mysql_global_status_open_table_definitions{instance=~"$instance"}',
            refId: "B",
            legendFormat: "definitions",
          },
        ],
      },
      {
        id: 12,
        title: "Table Cache Hit Ratio",
        type: "gauge",
        gridPos: { h: 6, w: 8, x: 8, y: 30 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'mysql_global_status_table_open_cache_hits{instance=~"$instance"} / (mysql_global_status_table_open_cache_hits{instance=~"$instance"} + mysql_global_status_table_open_cache_misses{instance=~"$instance"})',
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
                { value: 0, color: "red" },
                { value: 0.8, color: "yellow" },
                { value: 0.95, color: "green" },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 13,
        title: "Temporary Tables (disk vs memory)",
        type: "timeseries",
        gridPos: { h: 6, w: 8, x: 16, y: 30 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'rate(mysql_global_status_created_tmp_tables{instance=~"$instance"}[5m])',
            refId: "A",
            legendFormat: "memory/s",
          },
          {
            expr: 'rate(mysql_global_status_created_tmp_disk_tables{instance=~"$instance"}[5m])',
            refId: "B",
            legendFormat: "disk/s",
          },
        ],
        fieldConfig: {
          defaults: {},
          overrides: [
            {
              matcher: { id: "byName", options: "disk/s" },
              properties: [{ id: "color", value: { mode: "fixed", fixedColor: "red" } }],
            },
          ],
        },
      },
      {
        id: 14,
        title: "InnoDB Row Operations / sec",
        type: "timeseries",
        gridPos: { h: 6, w: 12, x: 0, y: 36 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'rate(mysql_global_status_innodb_rows_read{instance=~"$instance"}[5m])',
            refId: "A",
            legendFormat: "reads",
          },
          {
            expr: 'rate(mysql_global_status_innodb_rows_inserted{instance=~"$instance"}[5m])',
            refId: "B",
            legendFormat: "inserts",
          },
          {
            expr: 'rate(mysql_global_status_innodb_rows_updated{instance=~"$instance"}[5m])',
            refId: "C",
            legendFormat: "updates",
          },
          {
            expr: 'rate(mysql_global_status_innodb_rows_deleted{instance=~"$instance"}[5m])',
            refId: "D",
            legendFormat: "deletes",
          },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 15,
        title: "InnoDB Buffer Pool Hit Ratio",
        type: "gauge",
        gridPos: { h: 6, w: 6, x: 12, y: 36 },
        datasource: PROM_DS,
        targets: [
          {
            expr: '1 - (rate(mysql_global_status_innodb_buffer_pool_reads{instance=~"$instance"}[5m]) / rate(mysql_global_status_innodb_buffer_pool_read_requests{instance=~"$instance"}[5m]))',
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
                { value: 0, color: "red" },
                { value: 0.95, color: "yellow" },
                { value: 0.99, color: "green" },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 16,
        title: "Handler Operations / sec",
        type: "timeseries",
        gridPos: { h: 6, w: 6, x: 18, y: 36 },
        datasource: PROM_DS,
        targets: [
          {
            expr: 'rate(mysql_global_status_handlers_total{instance=~"$instance"}[5m])',
            refId: "A",
            legendFormat: "{{handler}}",
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
 * Create a per-cluster MariaDB dashboard ConfigMap.
 *
 * Called from `operator/mariadb.ts` after creating each MariaDB instance.
 */
export function createMariadbClusterDashboard(
  clusterName: string,
  namespace: string,
  provider: k8s.Provider,
  dependsOn: pulumi.Resource[]
): void {
  createDashboardConfigMap(
    clusterName,
    `mariadb-${clusterName}`,
    mariadbClusterDashboard(clusterName),
    namespace,
    provider,
    dependsOn,
    "Nimbus / Data / MariaDB"
  );
}
