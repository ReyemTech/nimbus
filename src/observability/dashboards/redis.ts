/**
 * Redis Grafana dashboard — memory, connections, hit ratio, commands,
 * network I/O, evictions, fragmentation, and replication.
 *
 * @module observability/dashboards/redis
 */

import { PROM_DS } from "./_helpers";

/** Grafana dashboard JSON for Redis metrics (10 panels). */
export function redisDashboard(): Record<string, unknown> {
  return {
    uid: "nimbus-redis",
    title: "Nimbus / Data / Redis",
    tags: ["nimbus", "redis"],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    refresh: "30s",
    panels: [
      {
        id: 1,
        title: "Memory Usage",
        type: "gauge",
        gridPos: { h: 6, w: 6, x: 0, y: 0 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "redis_memory_used_bytes / redis_memory_max_bytes",
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
                { color: "yellow", value: 0.7 },
                { color: "red", value: 0.9 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 2,
        title: "Memory Used",
        type: "timeseries",
        gridPos: { h: 6, w: 6, x: 6, y: 0 },
        datasource: PROM_DS,
        targets: [
          { expr: "redis_memory_used_bytes", refId: "A", legendFormat: "Used" },
          { expr: "redis_memory_max_bytes", refId: "B", legendFormat: "Max" },
        ],
        fieldConfig: { defaults: { unit: "bytes" }, overrides: [] },
      },
      {
        id: 3,
        title: "Connected Clients",
        type: "timeseries",
        gridPos: { h: 6, w: 6, x: 12, y: 0 },
        datasource: PROM_DS,
        targets: [{ expr: "redis_connected_clients", refId: "A", legendFormat: "Clients" }],
      },
      {
        id: 4,
        title: "Blocked Clients",
        type: "stat",
        gridPos: { h: 6, w: 6, x: 18, y: 0 },
        datasource: PROM_DS,
        targets: [{ expr: "redis_blocked_clients", refId: "A", legendFormat: "Blocked" }],
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
        title: "Commands/sec",
        type: "timeseries",
        gridPos: { h: 6, w: 8, x: 0, y: 6 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "rate(redis_commands_processed_total[5m])",
            refId: "A",
            legendFormat: "cmd/s",
          },
        ],
        fieldConfig: { defaults: { unit: "ops" }, overrides: [] },
      },
      {
        id: 6,
        title: "Hit Ratio",
        type: "gauge",
        gridPos: { h: 6, w: 8, x: 8, y: 6 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "redis_keyspace_hits_total / (redis_keyspace_hits_total + redis_keyspace_misses_total)",
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
                { color: "yellow", value: 0.8 },
                { color: "green", value: 0.95 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 7,
        title: "Network I/O",
        type: "timeseries",
        gridPos: { h: 6, w: 8, x: 16, y: 6 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "rate(redis_net_input_bytes_total[5m])",
            refId: "A",
            legendFormat: "Input",
          },
          {
            expr: "rate(redis_net_output_bytes_total[5m])",
            refId: "B",
            legendFormat: "Output",
          },
        ],
        fieldConfig: { defaults: { unit: "Bps" }, overrides: [] },
      },
      {
        id: 8,
        title: "Evicted Keys",
        type: "timeseries",
        gridPos: { h: 6, w: 8, x: 0, y: 12 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "rate(redis_evicted_keys_total[5m])",
            refId: "A",
            legendFormat: "evictions/s",
          },
        ],
        fieldConfig: {
          defaults: { color: { mode: "fixed", fixedColor: "red" } },
          overrides: [],
        },
      },
      {
        id: 9,
        title: "Memory Fragmentation",
        type: "timeseries",
        gridPos: { h: 6, w: 8, x: 8, y: 12 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "redis_allocator_frag_ratio",
            refId: "A",
            legendFormat: "frag ratio",
          },
        ],
        fieldConfig: {
          defaults: {
            thresholds: {
              steps: [
                { color: "green", value: 0 },
                { color: "yellow", value: 1.5 },
                { color: "red", value: 2 },
              ],
            },
          },
          overrides: [],
        },
      },
      {
        id: 10,
        title: "Connected Replicas",
        type: "stat",
        gridPos: { h: 6, w: 8, x: 16, y: 12 },
        datasource: PROM_DS,
        targets: [
          {
            expr: "redis_connected_slaves",
            refId: "A",
            legendFormat: "Replicas",
          },
        ],
        fieldConfig: {
          defaults: { thresholds: { steps: [{ color: "blue", value: 0 }] } },
          overrides: [],
        },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}
