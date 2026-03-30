/**
 * Observability stack implementation — deploys Prometheus, Grafana, Loki,
 * Alloy, and Alertmanager as a cohesive monitoring/logging stack.
 *
 * @module observability/stack
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type {
  IAlertmanagerConfig,
  IAlloyConfig,
  IGrafanaConfig,
  ILokiConfig,
  IObservabilityStack,
  IObservabilityStackConfig,
  IPrometheusConfig,
} from "./interfaces";
import { createDashboards, lokiLogsDashboard } from "./dashboards/index";
import { resolveStorageTier } from "../types/storage-tiers";

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
      grafanaPlugins
    );
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

  return { name, cluster, components };
}

function deployKubePrometheusStack(
  name: string,
  namespace: string,
  domain: string,
  prometheus: IPrometheusConfig | undefined,
  grafana: IGrafanaConfig | undefined,
  alertmanager: IAlertmanagerConfig | undefined,
  provider: k8s.Provider,
  storageTiers?: import("../types/storage-tiers").StorageTierMap,
  grafanaPlugins?: string[]
): k8s.helm.v3.Release {
  const certName = domain.replace(/\./g, "-");
  const tlsSecretName = `${certName}-wildcard-tls`;

  // Prometheus values
  const prometheusValues: Record<string, unknown> = {
    enabled: prometheus?.enabled ?? false,
  };
  if (prometheus?.enabled) {
    const promSubdomain = prometheus.subdomain ?? "prometheus";
    const promStorageClass = resolveStorageTier(
      prometheus.storageTier ?? "standard",
      storageTiers
    );
    prometheusValues["prometheusSpec"] = {
      serviceMonitorSelectorNilUsesHelmValues: false,
      podMonitorSelectorNilUsesHelmValues: false,
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
    prometheusValues["ingress"] = {
      enabled: true,
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
    alertmanagerValues["ingress"] = {
      enabled: true,
      ingressClassName: "traefik",
      hosts: [`${amSubdomain}.${domain}`],
      annotations: {
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      },
      tls: [{ secretName: tlsSecretName, hosts: [`${amSubdomain}.${domain}`] }],
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
  storageTiers?: import("../types/storage-tiers").StorageTierMap
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
    lokiValues["gateway"] = { enabled: false };
    lokiValues["chunksCache"] = { enabled: false };
    lokiValues["resultsCache"] = { enabled: false };
    lokiValues["backend"] = { replicas: 0 };
    lokiValues["read"] = { replicas: 0 };
    lokiValues["write"] = { replicas: 0 };
    const lokiStorageClass = resolveStorageTier(
      config.storageTier ?? "standard",
      storageTiers
    );
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
