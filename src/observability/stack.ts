/**
 * Observability stack implementation — deploys Prometheus, Grafana, Loki,
 * Alloy, and Alertmanager as a cohesive monitoring/logging stack.
 *
 * @module observability/stack
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type {
  IAlertConfig,
  IAlertmanagerConfig,
  IAlloyConfig,
  IGrafanaConfig,
  ILokiConfig,
  IObservabilityStack,
  IObservabilityStackConfig,
  IPrometheusConfig,
  IUptimeKumaConfig,
} from "./interfaces";
import { ensureNamespace } from "../utils/ensure-namespace";
import type { IExposedService } from "../types";
import type { StorageTierMap } from "../types/storage-tiers";
import { createDashboards, lokiLogsDashboard } from "./dashboards/index";
import { resolveStorageTier } from "../types/storage-tiers";
import { createGlobalAlertRules, buildAlertmanagerConfig } from "./alerts";

/**
 * Default Helm chart versions. Used only when the consumer doesn't pass `version`.
 * Set to `undefined` to let Helm resolve the latest available version.
 */
const DEFAULT_VERSIONS: Record<string, string | undefined> = {
  kubePrometheusStack: undefined,
  loki: undefined,
  alloy: undefined,
} as const;

/**
 * Deploy an observability stack to a cluster.
 *
 * Installs Prometheus, Grafana, Loki, Alloy, and Alertmanager via Helm.
 * Each component is individually gated by its `enabled` flag.
 *
 * @example
 * ```typescript
 * const obs = createObservabilityStack("prod", {
 *   cluster,
 *   domain: "reyem.tech",
 *   prometheus: { enabled: true },
 *   grafana: { enabled: true },
 *   loki: { enabled: true },
 *   alloy: { enabled: true },
 * });
 * ```
 *
 * @param name - Stack name prefix for all resources
 * @param config - Observability stack configuration
 * @returns Deployed observability stack
 */
export function createObservabilityStack(
  name: string,
  config: IObservabilityStackConfig
): IObservabilityStack {
  const cluster = config.cluster;
  const provider = cluster.provider;
  const namespace = config.namespace ?? "observability";
  const components: Record<string, k8s.helm.v3.Release> = {};

  // 1. Create the namespace
  new k8s.core.v1.Namespace(
    `${name}-ns`,
    {
      metadata: { name: namespace },
    },
    { provider }
  );

  // 2. kube-prometheus-stack (Prometheus + Grafana + Alertmanager)
  const prometheusEnabled = config.prometheus?.enabled === true;
  const grafanaEnabled = config.grafana?.enabled === true;
  const alertmanagerEnabled = config.alertmanager?.enabled === true;

  // Grafana plugins to install (built up based on datasources configured)
  const grafanaPlugins: string[] = [];
  if (config.neo4jEndpoint) {
    grafanaPlugins.push("kniepdennis-neo4j-datasource");
  }

  if (prometheusEnabled || grafanaEnabled || alertmanagerEnabled) {
    components["kube-prometheus-stack"] = deployKubePrometheusStack(
      name,
      namespace,
      config.domain,
      config.prometheus,
      config.grafana,
      config.alertmanager,
      provider,
      cluster.storageTiers,
      grafanaPlugins,
      config.alerts
    );
  }

  // Global alert rules (PVC, cert-manager) — after kube-prometheus-stack
  if (config.alerts && components["kube-prometheus-stack"]) {
    createGlobalAlertRules(name, namespace, provider, [components["kube-prometheus-stack"]]);
  }

  // 3. Loki (log aggregation)
  if (config.loki?.enabled) {
    components["loki"] = deployLoki(name, namespace, config.loki, provider, cluster.storageTiers);
  }

  // 4. Alloy (log/metric collector)
  if (config.alloy?.enabled) {
    const lokiEndpoint = components["loki"]
      ? components["loki"].status.apply(
          (s) => `http://${s?.name ?? "loki"}.${namespace}.svc.cluster.local:3100/loki/api/v1/push`
        )
      : pulumi.output(`http://loki.${namespace}.svc.cluster.local:3100/loki/api/v1/push`);
    components["alloy"] = deployAlloy(name, namespace, config.alloy, provider, lokiEndpoint);
  }

  // 5. Loki datasource + dashboard for Grafana
  if (components["loki"] && grafanaEnabled) {
    const lokiUrl = components["loki"].status.apply(
      (s) => `http://${s?.name ?? "loki"}.${namespace}.svc.cluster.local:3100`
    );

    // Loki datasource ConfigMap (sidecar picks it up)
    new k8s.core.v1.ConfigMap(
      `${name}-grafana-loki-datasource`,
      {
        metadata: {
          name: `${name}-grafana-loki-datasource`,
          namespace,
          labels: { grafana_datasource: "1" },
        },
        data: {
          "loki-datasource.yaml": lokiUrl.apply((url) =>
            JSON.stringify({
              apiVersion: 1,
              datasources: [
                {
                  name: "Loki",
                  type: "loki",
                  uid: "loki",
                  url,
                  access: "proxy",
                  isDefault: false,
                  jsonData: { maxLines: 1000 },
                },
              ],
            })
          ),
        },
      },
      {
        provider,
        dependsOn: [components["loki"], components["kube-prometheus-stack"]].filter(
          Boolean
        ) as k8s.helm.v3.Release[],
      }
    );

    // Loki logs explorer dashboard (under Nimbus folder)
    new k8s.core.v1.ConfigMap(
      `${name}-grafana-loki-dashboard`,
      {
        metadata: {
          name: `${name}-loki-logs-dashboard`,
          namespace,
          labels: { grafana_dashboard: "1" },
          annotations: { grafana_folder: "Nimbus" },
        },
        data: {
          "loki-logs.json": JSON.stringify(lokiLogsDashboard()),
        },
      },
      {
        provider,
        dependsOn: [components["kube-prometheus-stack"]].filter(Boolean) as k8s.helm.v3.Release[],
      }
    );
  }

  // 6. Neo4j Grafana datasource (Cypher query support)
  if (config.neo4jEndpoint && grafanaEnabled && components["kube-prometheus-stack"]) {
    // Neo4j datasource ConfigMap (sidecar picks it up).
    // Read the admin password from the stored secret for the datasource config.
    const neo4jPasswordSecretName = config.neo4jPasswordSecret;
    const neo4jPassword = neo4jPasswordSecretName
      ? k8s.core.v1.Secret.get(
          `${name}-neo4j-ds-password-read`,
          pulumi.interpolate`data/${neo4jPasswordSecretName}`,
          { provider }
        ).data.apply((d) => Buffer.from(d?.["password"] ?? "", "base64").toString())
      : pulumi.output("neo4j");

    new k8s.core.v1.ConfigMap(
      `${name}-grafana-neo4j-datasource`,
      {
        metadata: {
          name: `${name}-grafana-neo4j-datasource`,
          namespace,
          labels: { grafana_datasource: "1" },
        },
        data: {
          "neo4j-datasource.yaml": pulumi
            .all([pulumi.output(config.neo4jEndpoint), neo4jPassword])
            .apply(([endpoint, pw]) => {
              // Convert bolt:// to neo4j:// scheme (Go driver v5+ requirement)
              const url = endpoint.replace(/^bolt:\/\//, "neo4j://");
              return JSON.stringify({
                apiVersion: 1,
                datasources: [
                  {
                    name: "Neo4j",
                    type: "kniepdennis-neo4j-datasource",
                    uid: "neo4j",
                    // Plugin reads URL from jsonData, not top-level url
                    url: url,
                    access: "proxy",
                    isDefault: false,
                    jsonData: {
                      url,
                      database: "neo4j",
                      username: "neo4j",
                    },
                    secureJsonData: { password: pw },
                  },
                ],
              });
            }),
        },
      },
      {
        provider,
        dependsOn: [components["kube-prometheus-stack"]],
      }
    );
  }

  // 7. Component dashboards and ServiceMonitors
  if (components["kube-prometheus-stack"]) {
    createDashboards(name, {
      namespace,
      provider,
      dependsOn: [components["kube-prometheus-stack"]],
    });
  }

  // 8. Uptime Kuma (uptime monitoring)
  if (config.uptimeKuma?.enabled) {
    components["uptime-kuma"] = deployUptimeKuma(
      name,
      config.domain,
      config.uptimeKuma,
      provider
    );
  }

  // Collect exposed services — use Helm release name to derive K8s service names
  const exposedServices: IExposedService[] = [];
  const kpsRelease = components["kube-prometheus-stack"];

  if (kpsRelease) {
    const releaseName = kpsRelease.status.apply((s) => s?.name ?? "");

    if (grafanaEnabled && config.grafana?.expose !== false) {
      const originalName = releaseName.apply((r) => `${r}-grafana`);
      exposedServices.push({
        name: "grafana",
        originalName,
        namespace,
        port: 80,
        label: "grafana",
      });
    }

    if (prometheusEnabled && config.prometheus?.expose !== false) {
      const originalName = `${name}-kube-prometheus-prometheus`;
      exposedServices.push({
        name: "prometheus",
        originalName,
        namespace,
        port: 9090,
        label: "prometheus",
      });
    }

    if (alertmanagerEnabled && config.alertmanager?.expose !== false) {
      const originalName = `${name}-kube-prometheus-alertmanager`;
      exposedServices.push({
        name: "alertmanager",
        originalName,
        namespace,
        port: 9093,
        label: "alertmanager",
      });
    }
  }

  if (components["uptime-kuma"] && config.uptimeKuma?.expose) {
    const ukReleaseName = components["uptime-kuma"].status.apply((s) => s?.name ?? "");
    exposedServices.push({
      name: "uptime-kuma",
      originalName: ukReleaseName,
      namespace: "uptime-kuma",
      port: 3001,
      label: "uptime-kuma",
    });
  }

  return { name, cluster, components, exposedServices };
}

function deployKubePrometheusStack(
  name: string,
  namespace: string,
  domain: string,
  prometheus: IPrometheusConfig | undefined,
  grafana: IGrafanaConfig | undefined,
  alertmanager: IAlertmanagerConfig | undefined,
  provider: k8s.Provider,
  storageTiers?: StorageTierMap,
  grafanaPlugins?: string[],
  alertConfig?: IAlertConfig
): k8s.helm.v3.Release {
  const certName = domain.replace(/\./g, "-");
  const tlsSecretName = `${certName}-wildcard-tls`;

  // Prometheus values
  const prometheusValues: Record<string, unknown> = {
    enabled: prometheus?.enabled ?? false,
  };
  if (prometheus?.enabled) {
    const promSubdomain = prometheus.subdomain ?? "prometheus";
    const promStorageClass = resolveStorageTier(prometheus.storageTier ?? "standard", storageTiers);
    prometheusValues["prometheusSpec"] = {
      serviceMonitorSelectorNilUsesHelmValues: false,
      podMonitorSelectorNilUsesHelmValues: false,
      ruleSelectorNilUsesHelmValues: false,
      retention: prometheus.retention ?? "15d",
      storageSpec: {
        volumeClaimTemplate: {
          spec: {
            // Note: storageClassName can only be set on initial creation.
            // Changing it on an existing StatefulSet requires manual PVC migration.
            ...(promStorageClass ? { storageClassName: promStorageClass } : {}),
            resources: {
              requests: {
                storage: `${prometheus.storageGb ?? 20}Gi`,
              },
            },
          },
        },
      },
    };
    // Disable public ingress when exposed via access gateway (expose defaults to true)
    const promIngressEnabled = prometheus?.expose === false;
    prometheusValues["ingress"] = {
      enabled: promIngressEnabled,
      ingressClassName: "traefik",
      hosts: [`${promSubdomain}.${domain}`],
      annotations: {
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      },
      tls: [{ secretName: tlsSecretName, hosts: [`${promSubdomain}.${domain}`] }],
    };
  }

  // Grafana values
  const grafanaValues: Record<string, unknown> = {
    enabled: grafana?.enabled ?? false,
  };
  if (grafana?.enabled) {
    const grafSubdomain = grafana.subdomain ?? "grafana";
    grafanaValues["ingress"] = {
      enabled: true,
      ingressClassName: "traefik",
      hosts: [`${grafSubdomain}.${domain}`],
      annotations: {
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      },
      tls: [{ secretName: tlsSecretName, hosts: [`${grafSubdomain}.${domain}`] }],
    };

    // Install additional Grafana plugins
    if (grafanaPlugins && grafanaPlugins.length > 0) {
      grafanaValues["plugins"] = grafanaPlugins;
    }

    // Grafana SMTP for email alerts (uses the email transport's credentials)
    if (alertConfig?.email) {
      const transport = alertConfig.email.transport;
      grafanaValues["smtp"] = {
        enabled: true,
        host: `${transport.host}:${transport.port}`,
        user: transport.username,
        from_address: transport.fromAddress,
        from_name: "Nimbus Grafana",
      };
      if (transport.secretName) {
        grafanaValues["extraSecretMounts"] = [
          {
            name: "smtp-password",
            secretName: transport.secretName,
            defaultMode: "0440",
            mountPath: "/etc/secrets/smtp-password",
            readOnly: true,
          },
        ];
        (grafanaValues["smtp"] as Record<string, unknown>)["password"] =
          "$__file{/etc/secrets/smtp-password/password}";
      }
    }

    // Dashboard + datasource sidecars for configmap-based persistence
    if ((grafana.dashboardPersistence ?? "configmap") === "configmap") {
      grafanaValues["sidecar"] = {
        dashboards: {
          enabled: true,
          searchNamespace: "ALL",
          label: "grafana_dashboard",
        },
        datasources: {
          enabled: true,
          searchNamespace: "ALL",
          label: "grafana_datasource",
        },
      };
    }
  }

  // Alertmanager values
  const alertmanagerValues: Record<string, unknown> = {
    enabled: alertmanager?.enabled ?? false,
  };
  if (alertmanager?.enabled) {
    const amSubdomain = alertmanager.subdomain ?? "alertmanager";
    const amIngressEnabled = alertmanager?.expose === false;
    alertmanagerValues["ingress"] = {
      enabled: amIngressEnabled,
      ...(amIngressEnabled && {
        ingressClassName: "traefik",
        hosts: [`${amSubdomain}.${domain}`],
        annotations: {
          "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
        },
        tls: [{ secretName: tlsSecretName, hosts: [`${amSubdomain}.${domain}`] }],
      }),
    };
  }

  // Determine the chart version — use prometheus version, grafana version, alertmanager version, or default
  const version =
    prometheus?.version ??
    grafana?.version ??
    alertmanager?.version ??
    DEFAULT_VERSIONS.kubePrometheusStack;

  return new k8s.helm.v3.Release(
    `${name}-kube-prometheus-stack`,
    {
      chart: "kube-prometheus-stack",
      repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
      version,
      namespace,
      createNamespace: false,
      values: {
        prometheus: prometheusValues,
        grafana: grafanaValues,
        alertmanager: alertmanagerValues,
        ...prometheus?.values,
        ...grafana?.values,
        ...alertmanager?.values,
        ...(alertConfig
          ? { alertmanager: { ...alertmanagerValues, ...buildAlertmanagerConfig(alertConfig) } }
          : {}),
      },
    },
    { provider }
  );
}

function deployLoki(
  name: string,
  namespace: string,
  config: ILokiConfig,
  provider: k8s.Provider,
  storageTiers?: StorageTierMap
): k8s.helm.v3.Release {
  const mode = config.mode ?? "single-binary";
  const storageGb = config.storageGb ?? 10;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lokiValues: Record<string, any> = {};

  if (mode === "single-binary") {
    lokiValues["deploymentMode"] = "SingleBinary";
    lokiValues["singleBinary"] = {
      replicas: 1,
    };
    lokiValues["loki"] = {
      auth_enabled: false,
      commonConfig: {
        replication_factor: 1,
      },
      storage: {
        type: "filesystem",
      },
      schemaConfig: {
        configs: [
          {
            from: "2024-01-01",
            store: "tsdb",
            object_store: "filesystem",
            schema: "v13",
            index: { prefix: "index_", period: "24h" },
          },
        ],
      },
    };
    if (config.retention) {
      lokiValues["loki"]["limits_config"] = {
        retention_period: config.retention,
      };
      lokiValues["loki"]["compactor"] = {
        retention_enabled: true,
        delete_request_store: "filesystem",
      };
    }
    lokiValues["gateway"] = { enabled: false };
    lokiValues["chunksCache"] = { enabled: false };
    lokiValues["resultsCache"] = { enabled: false };
    lokiValues["backend"] = { replicas: 0 };
    lokiValues["read"] = { replicas: 0 };
    lokiValues["write"] = { replicas: 0 };
    const lokiStorageClass = resolveStorageTier(config.storageTier ?? "standard", storageTiers);
    lokiValues["singleBinary"]["persistence"] = {
      enabled: true,
      size: `${storageGb}Gi`,
      ...(lokiStorageClass ? { storageClass: lokiStorageClass } : {}),
    };
  }

  return new k8s.helm.v3.Release(
    `${name}-loki`,
    {
      chart: "loki",
      repositoryOpts: { repo: "https://grafana.github.io/helm-charts" },
      version: config.version ?? DEFAULT_VERSIONS.loki,
      namespace,
      createNamespace: false,
      values: {
        ...lokiValues,
        ...config.values,
      },
    },
    { provider }
  );
}

function deployAlloy(
  name: string,
  namespace: string,
  config: IAlloyConfig,
  provider: k8s.Provider,
  lokiEndpoint: pulumi.Output<string>
): k8s.helm.v3.Release {
  const alloyConfig = lokiEndpoint.apply(
    (endpoint) => `
logging {
  level  = "info"
  format = "logfmt"
}

discovery.kubernetes "pods" {
  role = "pod"
}

discovery.relabel "pods" {
  targets = discovery.kubernetes.pods.targets

  rule {
    source_labels = ["__meta_kubernetes_namespace"]
    target_label  = "namespace"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_name"]
    target_label  = "pod"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_container_name"]
    target_label  = "container"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_node_name"]
    target_label  = "node"
  }
  rule {
    source_labels = ["__meta_kubernetes_pod_label_app_kubernetes_io_name"]
    target_label  = "app"
  }
}

loki.source.kubernetes "pods" {
  targets    = discovery.relabel.pods.output
  forward_to = [loki.write.default.receiver]
}

loki.write "default" {
  endpoint {
    url = "${endpoint}"
  }
}
`
  );

  return new k8s.helm.v3.Release(
    `${name}-alloy`,
    {
      chart: "alloy",
      repositoryOpts: { repo: "https://grafana.github.io/helm-charts" },
      version: config.version ?? DEFAULT_VERSIONS.alloy,
      namespace,
      createNamespace: false,
      values: {
        alloy: {
          configMap: { content: alloyConfig },
        },
        ...config.values,
      },
    },
    { provider }
  );
}

function deployUptimeKuma(
  name: string,
  domain: string,
  config: IUptimeKumaConfig,
  provider: k8s.Provider
): k8s.helm.v3.Release {
  const ukNamespace = "uptime-kuma";
  const subdomain = config.subdomain ?? "uptime";

  const ns = ensureNamespace(ukNamespace, provider);

  const db = config.mariadbCluster.createDatabase("uptime-kuma", {
    namespaces: [ukNamespace],
  });

  const release = new k8s.helm.v3.Release(
    `${name}-uptime-kuma`,
    {
      chart: "uptime-kuma",
      repositoryOpts: { repo: "https://dirsigler.github.io/uptime-kuma-helm" },
      version: config.version,
      namespace: ukNamespace,
      createNamespace: false,
      values: {
        externalDatabase: {
          enabled: true,
          type: "mariadb",
          hostname: "mariadb-main.data.svc.cluster.local",
          port: 3306,
          database: "uptime-kuma",
          existingSecret: db.secrets[ukNamespace],
          existingSecretUsernameKey: "username",
          existingSecretPasswordKey: "password",
        },
        volume: { enabled: false },
        ingress: {
          enabled: true,
          className: "traefik",
          annotations: {
            "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
            "cert-manager.io/cluster-issuer": "letsencrypt-dns",
          },
          hosts: [{ host: `${subdomain}.${domain}`, paths: [{ path: "/", pathType: "Prefix" }] }],
          tls: [{ secretName: "uptime-kuma-tls", hosts: [`${subdomain}.${domain}`] }],
        },
        resources: {
          requests: { cpu: "50m", memory: "128Mi" },
          limits: { cpu: "500m", memory: "256Mi" },
        },
        serviceMonitor: { enabled: true },
        ...config.values,
      },
    },
    { provider, dependsOn: [ns] }
  );

  // Infrastructure monitors ConfigMap — must come after the release variable (databases, caches, etc.)
  const monitors = config.monitors ?? [];
  if (monitors.length > 0) {
    const infraMonitors = monitors.map((m) => ({
      name: m.name ?? `${m.hostname}:${m.port}`,
      url: m.url,
      hostname: m.hostname,
      port: m.port,
      type: m.type ?? "tcp",
      keyword: m.keyword,
      interval: m.interval ?? 60,
      group: m.group ?? "Infrastructure",
      connectionString: m.connectionString,
      dnsResolveType: m.dnsResolveType,
      dnsResolveServer: m.dnsResolveServer,
      grpcServiceName: m.grpcServiceName,
      extra: m.extra,
    }));

    new k8s.core.v1.ConfigMap(
      `${name}-kuma-infra-monitors`,
      {
        metadata: {
          name: "kuma-monitors-infrastructure",
          namespace: ukNamespace,
          labels: {
            "app.kubernetes.io/managed-by": "nimbus",
            "nimbus/component": "uptime-kuma-monitor",
            "nimbus/app": "infrastructure",
          },
        },
        data: { "monitors.json": JSON.stringify(infraMonitors, null, 2) },
      },
      { provider, dependsOn: [ns] }
    );
  }

  // Monitor reconciler — reads ConfigMaps labeled nimbus/component=uptime-kuma-monitor
  // from all namespaces and syncs them to Kuma via Socket.IO API.
  // Requires: Secret "kuma-api-key" with KUMA_API_KEY in uptime-kuma namespace.
  const reconcilerScript = [
    'const io = require("socket.io-client");',
    'const https = require("https");',
    'const fs = require("fs");',
    "",
    'const KUMA_URL = process.env.KUMA_URL || "http://localhost:3001";',
    "const API_KEY = process.env.KUMA_API_KEY;",
    'if (!API_KEY) { console.error("KUMA_API_KEY not set"); process.exit(1); }',
    "",
    "async function k8sGet(path) {",
    '  const token = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8");',
    '  const ca = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");',
    "  return new Promise((resolve, reject) => {",
    '    const req = https.get("https://kubernetes.default.svc" + path, { headers: { Authorization: "Bearer " + token }, ca }, (res) => {',
    '      let data = ""; res.on("data", c => data += c); res.on("end", () => resolve(JSON.parse(data)));',
    "    });",
    "    req.on('error', reject);",
    "  });",
    "}",
    "",
    "async function main() {",
    '  const cms = await k8sGet("/api/v1/configmaps?labelSelector=nimbus/component=uptime-kuma-monitor");',
    '  const desired = (cms.items || []).flatMap(cm => JSON.parse(cm.data["monitors.json"] || "[]"));',
    '  console.log("Desired monitors:", desired.length);',
    "",
    '  const socket = io(KUMA_URL, { extraHeaders: { Authorization: "Bearer " + API_KEY } });',
    '  await new Promise((resolve, reject) => { socket.on("connect", resolve); socket.on("connect_error", reject); setTimeout(() => reject(new Error("timeout")), 10000); });',
    "",
    '  const existing = await new Promise(resolve => socket.emit("getMonitorList", resolve));',
    "  const byName = {};",
    "  const groupIds = {};",
    "  for (const [id, m] of Object.entries(existing)) {",
    "    byName[m.name] = parseInt(id);",
    '    if (m.type === "group") groupIds[m.name] = parseInt(id);',
    "  }",
    "",
    "  // Ensure groups exist",
    '  const groups = [...new Set(desired.map(m => m.group).filter(Boolean))];',
    "  for (const g of groups) {",
    "    if (groupIds[g]) continue;",
    '    console.log("CREATE GROUP:", g);',
    '    const res = await new Promise(resolve => socket.emit("add", { type: "group", name: g }, resolve));',
    "    if (res.ok) { groupIds[g] = res.monitorID; byName[g] = res.monitorID; }",
    '    else console.log("  FAIL:", res.msg);',
    "  }",
    "",
    "  for (const m of desired) {",
    '    if (byName[m.name]) { console.log("EXISTS:", m.name); continue; }',
    '    console.log("CREATE:", m.name);',
    '    const data = { type: m.type || "http", name: m.name, interval: m.interval || 60, retryInterval: 60, maxretries: 3 };',
    '    if (m.url) data.url = m.url;',
    '    if (m.hostname) data.hostname = m.hostname;',
    '    if (m.port) data.port = m.port;',
    '    if (m.keyword) data.keyword = m.keyword;',
    '    if (m.connectionString) data.databaseConnectionString = m.connectionString;',
    '    if (m.dnsResolveType) data.dns_resolve_type = m.dnsResolveType;',
    '    if (m.dnsResolveServer) data.dns_resolve_server = m.dnsResolveServer;',
    '    if (m.grpcServiceName) data.grpcServiceName = m.grpcServiceName;',
    '    if (["http","keyword","json-query"].includes(data.type)) data.accepted_statuscodes = ["200-299"];',
    '    if (m.extra) Object.assign(data, m.extra);',
    "    if (m.group && groupIds[m.group]) data.parent = groupIds[m.group];",
    '    const res = await new Promise(resolve => socket.emit("add", data, resolve));',
    '    if (res.ok) byName[m.name] = res.monitorID;',
    '    console.log(res.ok ? "  OK" : "  FAIL: " + res.msg);',
    "  }",
    "  socket.disconnect();",
    '}',
    "main().catch(e => { console.error(e); process.exit(1); });",
  ].join("\n");

  new k8s.core.v1.ConfigMap(
    `${name}-kuma-reconciler-script`,
    {
      metadata: { name: "kuma-reconciler-script", namespace: ukNamespace },
      data: { "reconcile.js": reconcilerScript },
    },
    { provider, dependsOn: [ns] }
  );

  new k8s.batch.v1.CronJob(
    `${name}-kuma-reconciler`,
    {
      metadata: { name: "kuma-monitor-reconciler", namespace: ukNamespace },
      spec: {
        schedule: "*/5 * * * *",
        successfulJobsHistoryLimit: 1,
        failedJobsHistoryLimit: 3,
        jobTemplate: {
          spec: {
            template: {
              spec: {
                serviceAccountName: "kuma-reconciler",
                restartPolicy: "OnFailure",
                containers: [{
                  name: "reconciler",
                  image: "node:22-alpine",
                  command: ["sh", "-c", "cd /tmp && npm init -y > /dev/null 2>&1 && npm install --no-package-lock socket.io-client > /dev/null 2>&1 && NODE_PATH=/tmp/node_modules node /scripts/reconcile.js"],
                  env: [
                    { name: "KUMA_API_KEY", valueFrom: { secretKeyRef: { name: "kuma-api-key", key: "KUMA_API_KEY" } } },
                    { name: "KUMA_URL", value: release.status.apply((s) => `http://${s?.name ?? "uptime-kuma"}.${ukNamespace}.svc.cluster.local:3001`) },
                  ],
                  volumeMounts: [{ name: "script", mountPath: "/scripts" }],
                }],
                volumes: [{ name: "script", configMap: { name: "kuma-reconciler-script" } }],
              },
            },
          },
        },
      },
    },
    { provider, dependsOn: [ns] }
  );

  new k8s.core.v1.ServiceAccount(
    `${name}-kuma-reconciler-sa`,
    { metadata: { name: "kuma-reconciler", namespace: ukNamespace } },
    { provider, dependsOn: [ns] }
  );

  new k8s.rbac.v1.ClusterRole(
    `${name}-kuma-reconciler-role`,
    {
      metadata: { name: "kuma-monitor-reader" },
      rules: [{ apiGroups: [""], resources: ["configmaps"], verbs: ["get", "list"] }],
    },
    { provider }
  );

  new k8s.rbac.v1.ClusterRoleBinding(
    `${name}-kuma-reconciler-binding`,
    {
      metadata: { name: "kuma-monitor-reader" },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: "kuma-monitor-reader" },
      subjects: [{ kind: "ServiceAccount", name: "kuma-reconciler", namespace: ukNamespace }],
    },
    { provider }
  );

  return release;
}
