/**
 * Loki Logs Explorer Grafana dashboard — log volume and log viewer
 * with namespace, pod, container, and search template variables.
 *
 * @module observability/dashboards/loki
 */

/** Grafana dashboard JSON for the Loki Logs Explorer. */
export function lokiLogsDashboard(): Record<string, unknown> {
  return {
    uid: "loki-logs-explorer",
    title: "Nimbus / Loki Logs Explorer",
    tags: ["nimbus", "loki", "logs"],
    timezone: "browser",
    editable: true,
    time: { from: "now-1h", to: "now" },
    refresh: "30s",
    templating: {
      list: [
        {
          name: "namespace",
          type: "query",
          datasource: { type: "loki", uid: "loki" },
          query: { label: "namespace", refId: "A", stream: "", type: 1 },
          refresh: 2,
          sort: 1,
          includeAll: true,
          current: { text: "All", value: "$__all" },
        },
        {
          name: "pod",
          type: "query",
          datasource: { type: "loki", uid: "loki" },
          query: { label: "pod", refId: "A", stream: '{namespace=~"$namespace"}', type: 1 },
          refresh: 2,
          sort: 1,
          includeAll: true,
          current: { text: "All", value: "$__all" },
        },
        {
          name: "container",
          type: "query",
          datasource: { type: "loki", uid: "loki" },
          query: {
            label: "container",
            refId: "A",
            stream: '{namespace=~"$namespace", pod=~"$pod"}',
            type: 1,
          },
          refresh: 2,
          sort: 1,
          includeAll: true,
          current: { text: "All", value: "$__all" },
        },
        {
          name: "search",
          type: "textbox",
          current: { text: "", value: "" },
        },
      ],
    },
    panels: [
      {
        id: 1,
        title: "Log Volume",
        type: "timeseries",
        gridPos: { h: 6, w: 24, x: 0, y: 0 },
        datasource: { type: "loki", uid: "loki" },
        targets: [
          {
            expr: 'sum(count_over_time({namespace=~"$namespace", pod=~"$pod", container=~"$container"} |~ "$search" [1m])) by (namespace)',
            refId: "A",
            legendFormat: "{{namespace}}",
          },
        ],
        fieldConfig: {
          defaults: {
            custom: { drawStyle: "bars", fillOpacity: 30, stacking: { mode: "normal" } },
          },
          overrides: [],
        },
      },
      {
        id: 2,
        title: "Logs",
        type: "logs",
        gridPos: { h: 20, w: 24, x: 0, y: 6 },
        datasource: { type: "loki", uid: "loki" },
        targets: [
          {
            expr: '{namespace=~"$namespace", pod=~"$pod", container=~"$container"} |~ "$search"',
            refId: "A",
          },
        ],
        options: {
          showTime: true,
          showLabels: true,
          showCommonLabels: false,
          wrapLogMessage: true,
          prettifyLogMessage: false,
          enableLogDetails: true,
          sortOrder: "Descending",
          dedupStrategy: "none",
        },
      },
    ],
    schemaVersion: 39,
    version: 1,
  };
}
