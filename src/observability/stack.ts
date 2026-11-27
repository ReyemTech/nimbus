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
import { createPrometheusRule } from "./alerts";
import { buildPodDisruptionBudgetSpec } from "../availability";
import { chartPodPlacement } from "../platform/components/scheduling";
import type { IPodDisruptionBudgetConfig, IPodSchedulingConfig } from "../availability";

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
  const observabilityNamespace = new k8s.core.v1.Namespace(
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
    if (
      config.prometheus?.podDisruptionBudget?.enabled !== false &&
      hasRawPdb(config.prometheus?.values?.prometheus)
    )
      throw new Error("Prometheus Nimbus podDisruptionBudget conflicts with raw Helm PDB settings");
    if (config.grafana?.podDisruptionBudget?.enabled !== false && hasRawPdb(config.grafana?.values))
      throw new Error("Grafana Nimbus podDisruptionBudget conflicts with raw Helm PDB settings");
    if (
      config.alertmanager?.podDisruptionBudget?.enabled !== false &&
      hasRawPdb(config.alertmanager?.values?.alertmanager)
    )
      throw new Error(
        "Alertmanager Nimbus podDisruptionBudget conflicts with raw Helm PDB settings"
      );
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
      config.alerts,
      observabilityNamespace,
      cluster.eksAddons,
      config.kubeStateMetrics
    );
    const instance = kubePrometheusReleaseName(name);
    if (prometheusEnabled)
      addChartBudget(
        `${name}-prometheus-pdb`,
        namespace,
        "prometheus",
        instance,
        config.prometheus?.podDisruptionBudget,
        config.prometheus?.scheduling?.replicas ?? 1,
        provider,
        components["kube-prometheus-stack"]
      );
    if (grafanaEnabled)
      addChartBudget(
        `${name}-grafana-pdb`,
        namespace,
        "grafana",
        instance,
        config.grafana?.podDisruptionBudget,
        config.grafana?.scheduling?.replicas ?? 1,
        provider,
        components["kube-prometheus-stack"]
      );
    if (alertmanagerEnabled)
      addChartBudget(
        `${name}-alertmanager-pdb`,
        namespace,
        "alertmanager",
        instance,
        config.alertmanager?.podDisruptionBudget,
        config.alertmanager?.scheduling?.replicas ?? 1,
        provider,
        components["kube-prometheus-stack"]
      );
    if (config.kubeStateMetrics && !cluster.eksAddons?.includes("kube-state-metrics"))
      addChartBudget(
        `${name}-kube-state-metrics-pdb`,
        namespace,
        "kube-state-metrics",
        instance,
        config.kubeStateMetrics.podDisruptionBudget,
        config.kubeStateMetrics.scheduling?.replicas ?? 1,
        provider,
        components["kube-prometheus-stack"]
      );
  }

  // Global alert rules (PVC, cert-manager) — after kube-prometheus-stack
  if (config.alerts && components["kube-prometheus-stack"]) {
    createGlobalAlertRules(name, namespace, provider, [
      observabilityNamespace,
      components["kube-prometheus-stack"],
    ]);
  }

  if (components["kube-prometheus-stack"]) {
    createPrometheusRule(
      `${name}-traefik-alerts`,
      namespace,
      [
        {
          name: "nimbus.traefik",
          rules: [
            {
              alert: "TraefikDown",
              expr: `kube_deployment_status_replicas_available{namespace="traefik",deployment=~".*traefik.*"} == 0`,
              for: "2m",
              labels: { severity: "critical" },
              annotations: {
                summary:
                  "Traefik ingress controller has 0 available replicas — all traffic stopped",
              },
            },
            {
              alert: "TraefikHighErrorRate",
              expr: `sum(rate(traefik_service_requests_total{code=~"5.."}[5m])) / sum(rate(traefik_service_requests_total[5m])) > 0.05`,
              for: "5m",
              labels: { severity: "warning" },
              annotations: {
                summary: "Traefik 5xx error rate is above 5% ({{ $value | humanizePercentage }})",
              },
            },
          ],
        },
      ],
      provider,
      [observabilityNamespace, components["kube-prometheus-stack"]]
    );
  }

  // 3. Loki (log aggregation)
  if (config.loki?.enabled) {
    const lokiMode = config.loki.mode ?? "single-binary";
    if (
      config.loki.podDisruptionBudget?.enabled !== false &&
      ((lokiMode === "distributed" && hasLokiComponentPdb(config.loki.values)) ||
        (lokiMode === "single-binary" && hasRawPdb(config.loki.values?.singleBinary)))
    ) {
      throw new Error("Loki component native PDB conflicts with Nimbus podDisruptionBudget");
    }
    components["loki"] = deployLoki(name, namespace, config.loki, provider, cluster.storageTiers);
    if (lokiMode === "distributed") {
      const distributed = [
        ["compactor", "compactor", 1],
        ["distributor", "distributor", 3],
        ["indexGateway", "index-gateway", 2],
        ["ingester", "ingester", 3],
        ["querier", "querier", 3],
        ["queryFrontend", "query-frontend", 2],
        ["queryScheduler", "query-scheduler", 2],
        ["gateway", "gateway", 1],
      ] as const;
      const enabled: Array<readonly [string, string, number]> = [...distributed];
      for (const [key, workload] of [
        ["patternIngester", "pattern-ingester"],
        ["ruler", "ruler"],
      ] as const) {
        const values = config.loki.values?.[key] as Record<string, unknown> | undefined;
        if (values?.enabled === true) enabled.push([key, workload, 1]);
      }
      for (const [key, workload, defaultReplicas] of enabled) {
        const values = config.loki.values?.[key] as Record<string, unknown> | undefined;
        const replicas =
          config.loki.scheduling?.replicas ??
          (typeof values?.replicas === "number" ? values.replicas : defaultReplicas);
        addChartBudget(
          `${name}-loki-${workload}-pdb`,
          namespace,
          "loki",
          `${name}-loki`,
          config.loki.podDisruptionBudget,
          replicas,
          provider,
          components["loki"],
          workload
        );
      }
    } else {
      addChartBudget(
        `${name}-loki-pdb`,
        namespace,
        "loki",
        `${name}-loki`,
        config.loki.podDisruptionBudget,
        config.loki.scheduling?.replicas ?? 1,
        provider,
        components["loki"],
        "single-binary"
      );
    }
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
    components["uptime-kuma"] = deployUptimeKuma(name, config.domain, config.uptimeKuma, provider);
    addChartBudget(
      `${name}-uptime-kuma-pdb`,
      "uptime-kuma",
      String(config.uptimeKuma.values?.nameOverride ?? "uptime-kuma")
        .slice(0, 63)
        .replace(/-+$/, ""),
      `${name}-uptime-kuma`,
      config.uptimeKuma.podDisruptionBudget,
      config.uptimeKuma.scheduling?.replicas ?? 1,
      provider,
      components["uptime-kuma"]
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

function hasLokiComponentPdb(values: ILokiConfig["values"]): boolean {
  if (!values) return false;
  const componentKeys = [
    "compactor",
    "distributor",
    "indexGateway",
    "ingester",
    "querier",
    "queryFrontend",
    "queryScheduler",
    "gateway",
    "patternIngester",
    "ruler",
  ];
  return componentKeys.some((key) => {
    const component = values[key] as Record<string, unknown> | undefined;
    if (!component) return false;
    if ((key === "patternIngester" || key === "ruler") && component.enabled !== true) return false;
    const native = component.podDisruptionBudget as Record<string, unknown> | undefined;
    return (
      component.maxUnavailable !== undefined ||
      component.minAvailable !== undefined ||
      (native !== undefined && native.enabled !== false)
    );
  });
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
  alertConfig?: IAlertConfig,
  namespaceResource?: pulumi.Resource,
  managedEksAddons?: ReadonlyArray<string>,
  kubeStateMetrics?: IObservabilityStackConfig["kubeStateMetrics"]
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
      ...(prometheus.scheduling?.replicas !== undefined
        ? { replicas: prometheus.scheduling.replicas }
        : {}),
      ...chartPodPlacement(
        prometheus.scheduling?.spread,
        { "app.kubernetes.io/name": "prometheus" },
        (prometheus.values?.prometheus as Record<string, unknown>) ?? {},
        "Prometheus"
      ),
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
    if (grafana.scheduling?.replicas !== undefined)
      grafanaValues["replicas"] = grafana.scheduling.replicas;
    Object.assign(
      grafanaValues,
      chartPodPlacement(
        grafana.scheduling?.spread,
        { "app.kubernetes.io/name": "grafana" },
        grafana.values ?? {},
        "Grafana"
      )
    );

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
    alertmanagerValues["alertmanagerSpec"] = {
      ...(alertmanager.scheduling?.replicas !== undefined
        ? { replicas: alertmanager.scheduling.replicas }
        : {}),
      ...chartPodPlacement(
        alertmanager.scheduling?.spread,
        { "app.kubernetes.io/name": "alertmanager" },
        (alertmanager.values?.alertmanager as Record<string, unknown>) ?? {},
        "Alertmanager"
      ),
    };
  }

  // Determine the chart version — use prometheus version, grafana version, alertmanager version, or default
  const version =
    prometheus?.version ??
    grafana?.version ??
    alertmanager?.version ??
    DEFAULT_VERSIONS.kubePrometheusStack;

  const releaseBase = `${name}-kps`
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const releaseName =
    releaseBase.length <= 53
      ? undefined
      : `${releaseBase.slice(0, 45).replace(/-+$/g, "")}-${Array.from(releaseBase)
          .reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 0)
          .toString(36)
          .slice(-7)}`;
  const stackValues: Record<string, unknown> = {
    prometheus: prometheusValues,
    grafana: grafanaValues,
    alertmanager: alertmanagerValues,
    ...prometheus?.values,
    ...grafana?.values,
    ...alertmanager?.values,
    ...(alertConfig
      ? { alertmanager: { ...alertmanagerValues, ...buildAlertmanagerConfig(alertConfig) } }
      : {}),
  };
  applyObservedScheduling(
    stackValues,
    "prometheus",
    prometheus?.scheduling,
    prometheus?.values,
    "prometheusSpec",
    "Prometheus"
  );
  applyObservedScheduling(
    stackValues,
    "grafana",
    grafana?.scheduling,
    grafana?.values,
    undefined,
    "Grafana"
  );
  applyObservedScheduling(
    stackValues,
    "alertmanager",
    alertmanager?.scheduling,
    alertmanager?.values,
    "alertmanagerSpec",
    "Alertmanager"
  );
  if (kubeStateMetrics && managedEksAddons?.includes("kube-state-metrics") !== true) {
    const values = (stackValues.kubeStateMetrics as Record<string, unknown>) ?? {};
    const raw = (prometheus?.values?.kubeStateMetrics as Record<string, unknown>) ?? {};
    if (kubeStateMetrics.scheduling?.replicas !== undefined) {
      if (raw.replicas !== undefined)
        throw new Error(
          "kube-state-metrics scheduling.replicas conflicts with Helm values.kubeStateMetrics.replicas"
        );
      values.replicas = kubeStateMetrics.scheduling.replicas;
    }
    if (
      kubeStateMetrics.podDisruptionBudget?.enabled !== false &&
      raw.podDisruptionBudget !== undefined
    ) {
      throw new Error(
        "kube-state-metrics podDisruptionBudget conflicts with Helm values.kubeStateMetrics.podDisruptionBudget"
      );
    }
    Object.assign(
      values,
      chartPodPlacement(
        kubeStateMetrics.scheduling?.spread,
        { "app.kubernetes.io/name": "kube-state-metrics" },
        raw,
        "kube-state-metrics"
      )
    );
    stackValues.kubeStateMetrics = values;
  }

  // The EKS community add-ons own these agents when selected. Disable the
  // kube-prometheus-stack subcharts to prevent duplicate DaemonSets/Deployments.
  if (managedEksAddons?.includes("prometheus-node-exporter")) {
    disableHelmSubchart(stackValues, "nodeExporter");
  }
  if (managedEksAddons?.includes("kube-state-metrics")) {
    disableHelmSubchart(stackValues, "kubeStateMetrics");
  }
  return new k8s.helm.v3.Release(
    `${name}-kube-prometheus-stack`,
    {
      chart: "kube-prometheus-stack",
      name: releaseName,
      repositoryOpts: { repo: "https://prometheus-community.github.io/helm-charts" },
      version,
      namespace,
      createNamespace: false,
      values: stackValues,
    },
    { provider, dependsOn: namespaceResource ? [namespaceResource] : undefined }
  );
}

function applyObservedScheduling(
  values: Record<string, unknown>,
  chartKey: string,
  scheduling: IPodSchedulingConfig | undefined,
  rawValues: Readonly<Record<string, unknown>> | undefined,
  nestedKey: string | undefined,
  component: string
): void {
  if (scheduling?.replicas === undefined && !scheduling?.spread) return;
  const chartValues = (values[chartKey] as Record<string, unknown>) ?? {};
  const rawChartValues = (rawValues?.[chartKey] as Record<string, unknown>) ?? {};
  const targetKey = nestedKey ?? "";
  const target = targetKey
    ? ((chartValues[targetKey] as Record<string, unknown>) ?? {})
    : chartValues;
  const rawTarget = targetKey
    ? ((rawChartValues[targetKey] as Record<string, unknown>) ?? {})
    : rawChartValues;
  if (scheduling.replicas !== undefined) {
    const path = targetKey ? `${targetKey}.replicas` : "replicas";
    if (rawTarget.replicas !== undefined)
      throw new Error(
        `${component} scheduling.replicas conflicts with Helm values.${chartKey}.${path}`
      );
    target.replicas = scheduling.replicas;
  }
  if (scheduling.spread)
    Object.assign(
      target,
      chartPodPlacement(
        scheduling.spread,
        { "app.kubernetes.io/name": chartKey },
        rawTarget,
        component
      )
    );
  if (targetKey) chartValues[targetKey] = target;
  values[chartKey] = chartValues;
}

function kubePrometheusReleaseName(name: string): string {
  const releaseBase = `${name}-kps`
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (releaseBase.length <= 53) return `${name}-kube-prometheus-stack`;
  return `${releaseBase.slice(0, 45).replace(/-+$/g, "")}-${Array.from(releaseBase)
    .reduce((acc, char) => (acc * 31 + char.charCodeAt(0)) >>> 0, 0)
    .toString(36)
    .slice(-7)}`;
}

function disableHelmSubchart(values: Record<string, unknown>, name: string): void {
  const current = values[name];
  values[name] = {
    ...(typeof current === "object" && current !== null
      ? (current as Record<string, unknown>)
      : {}),
    enabled: false,
  };
}

function addChartBudget(
  name: string,
  namespace: string,
  component: string,
  instance: string,
  policy: IPodDisruptionBudgetConfig | undefined,
  replicas: number,
  provider: k8s.Provider,
  dependsOn: k8s.helm.v3.Release,
  workload?: string
): void {
  const manifest = buildPodDisruptionBudgetSpec(
    policy ?? {},
    {
      "app.kubernetes.io/name": component,
      "app.kubernetes.io/instance": instance,
      ...(workload ? { "app.kubernetes.io/component": workload } : {}),
    },
    replicas
  );
  if (!manifest) return;
  new k8s.policy.v1.PodDisruptionBudget(
    name,
    { metadata: { name, namespace }, spec: manifest.spec },
    { provider, dependsOn: [dependsOn] }
  );
}

function hasRawPdb(values: unknown): boolean {
  if (typeof values !== "object" || values === null) return false;
  if (Object.prototype.hasOwnProperty.call(values, "podDisruptionBudget")) return true;
  return Object.values(values).some((value) => hasRawPdb(value));
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

  if (mode === "distributed") lokiValues["deploymentMode"] = "Distributed";

  return new k8s.helm.v3.Release(
    `${name}-loki`,
    {
      chart: "loki",
      repositoryOpts: { repo: "https://grafana.github.io/helm-charts" },
      version: config.version ?? DEFAULT_VERSIONS.loki,
      namespace,
      createNamespace: false,
      values: (() => {
        const values = { ...lokiValues, ...config.values };
        if (mode === "distributed") {
          for (const key of ["read", "write", "backend"]) {
            const raw = (config.values?.[key] as Record<string, unknown> | undefined) ?? {};
            if (typeof raw.replicas === "number" && raw.replicas !== 0) {
              throw new Error(
                `Loki distributed mode requires values.${key}.replicas to be 0; ${key} is a SimpleScalable target`
              );
            }
            values[key] = { ...raw, replicas: 0 };
          }
          const distributed = [
            ["compactor", "compactor", 1],
            ["distributor", "distributor", 3],
            ["indexGateway", "index-gateway", 2],
            ["ingester", "ingester", 3],
            ["querier", "querier", 3],
            ["queryFrontend", "query-frontend", 2],
            ["queryScheduler", "query-scheduler", 2],
            ["gateway", "gateway", 1],
          ] as const;
          const enabled: Array<readonly [string, string, number]> = [...distributed];
          for (const [key, workload] of [
            ["patternIngester", "pattern-ingester"],
            ["ruler", "ruler"],
          ] as const) {
            const raw = config.values?.[key] as Record<string, unknown> | undefined;
            if (raw?.enabled === true) enabled.push([key, workload, 1]);
          }
          for (const [key, workload, defaultReplicas] of enabled) {
            const raw = (config.values?.[key] as Record<string, unknown> | undefined) ?? {};
            if (
              config.scheduling?.replicas !== undefined &&
              typeof raw.replicas === "number" &&
              raw.replicas !== config.scheduling.replicas
            ) {
              throw new Error(
                `Loki scheduling.replicas conflicts with Helm values.${key}.replicas`
              );
            }
            const replicas =
              config.scheduling?.replicas ??
              (typeof raw.replicas === "number" ? raw.replicas : defaultReplicas);
            values[key] = {
              ...raw,
              replicas,
              ...chartPodPlacement(
                config.scheduling?.spread,
                {
                  "app.kubernetes.io/name": "loki",
                  "app.kubernetes.io/instance": `${name}-loki`,
                  "app.kubernetes.io/component": workload,
                },
                raw,
                `Loki ${key}`
              ),
            };
          }
        }
        if (config.scheduling?.replicas !== undefined) {
          const rawSingleBinary = (config.values?.singleBinary as Record<string, unknown>) ?? {};
          if (rawSingleBinary.replicas !== undefined)
            throw new Error(
              "Loki scheduling.replicas conflicts with Helm values.singleBinary.replicas"
            );
          values.singleBinary = {
            ...lokiValues.singleBinary,
            ...rawSingleBinary,
            replicas: config.scheduling.replicas,
          };
        }
        if (config.scheduling?.spread) {
          values.singleBinary = {
            ...(values.singleBinary as Record<string, unknown>),
            ...chartPodPlacement(
              config.scheduling.spread,
              { "app.kubernetes.io/name": "loki", "app.kubernetes.io/instance": `${name}-loki` },
              (config.values?.singleBinary as Record<string, unknown>) ?? {},
              "Loki"
            ),
          };
        }
        return values;
      })(),
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
  if (config.scheduling?.replicas !== undefined)
    throw new Error(
      "Uptime Kuma chart hard-codes one replica and does not support scheduling.replicas"
    );
  if (config.scheduling?.spread?.strategy === "topology-spread")
    throw new Error("Uptime Kuma chart does not support topology-spread scheduling");
  if (config.podDisruptionBudget?.enabled !== false && hasRawPdb(config.values))
    throw new Error("Uptime Kuma Nimbus podDisruptionBudget conflicts with raw Helm PDB settings");

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
        ...(config.scheduling?.spread
          ? chartPodPlacement(
              config.scheduling.spread,
              {
                "app.kubernetes.io/name": String(config.values?.nameOverride ?? "uptime-kuma")
                  .slice(0, 63)
                  .replace(/-+$/, ""),
                "app.kubernetes.io/instance": `${name}-uptime-kuma`,
              },
              config.values ?? {},
              "Uptime Kuma"
            )
          : {}),
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
    "const USERNAME = process.env.KUMA_USERNAME;",
    "const PASSWORD = process.env.KUMA_PASSWORD;",
    'if (!USERNAME || !PASSWORD) { console.error("KUMA_USERNAME and KUMA_PASSWORD must be set"); process.exit(1); }',
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
    "  const socket = io(KUMA_URL);",
    '  await new Promise((resolve, reject) => { socket.on("connect", resolve); socket.on("connect_error", reject); setTimeout(() => reject(new Error("connect timeout")), 10000); });',
    "",
    "  // Register monitorList handler BEFORE login (Kuma pushes it immediately after auth)",
    "  let monitorCache = null;",
    "  socket.on('monitorList', (data) => { monitorCache = data; });",
    "",
    "  // Authenticate with username/password",
    '  const loginRes = await new Promise((resolve) => socket.emit("login", { username: USERNAME, password: PASSWORD }, resolve));',
    '  if (!loginRes || !loginRes.ok) { console.error("Login failed:", JSON.stringify(loginRes)); process.exit(1); }',
    '  console.log("Authenticated as", USERNAME);',
    "",
    "  // Wait for monitorList to arrive",
    "  for (let i = 0; i < 10 && !monitorCache; i++) await new Promise(r => setTimeout(r, 1000));",
    "  const existing = monitorCache || {};",
    "",
    "  const byName = {};",
    "  const byUrl = {};",
    "  const groupIds = {};",
    "  for (const [id, m] of Object.entries(existing)) {",
    "    byName[m.name] = parseInt(id);",
    "    if (m.url) byUrl[m.url] = parseInt(id);",
    "    if (m.hostname && m.port) byUrl[m.hostname + ':' + m.port] = parseInt(id);",
    '    if (m.type === "group") groupIds[m.name] = parseInt(id);',
    "  }",
    '  console.log("Existing monitors:", Object.keys(byName).length, "groups:", Object.keys(groupIds).length);',
    "",
    "  // Ensure groups exist",
    "  const groups = [...new Set(desired.map(m => m.group).filter(Boolean))];",
    "  for (const g of groups) {",
    "    if (groupIds[g]) continue;",
    '    console.log("CREATE GROUP:", g);',
    '    const res = await new Promise(resolve => socket.emit("add", { type: "group", name: g, accepted_statuscodes: ["200-299"] }, resolve));',
    "    if (res.ok) { groupIds[g] = res.monitorID; byName[g] = res.monitorID; }",
    '    else console.log("  FAIL:", res.msg);',
    "  }",
    "",
    "  for (const m of desired) {",
    "    // Skip if monitor exists by name OR by URL/host:port",
    "    const urlKey = m.url || (m.hostname && m.port ? m.hostname + ':' + m.port : null);",
    "    if (byName[m.name] || (urlKey && byUrl[urlKey])) {",
    '      console.log("EXISTS:", m.name);',
    "      continue;",
    "    }",
    '    console.log("CREATE:", m.name);',
    '    const data = { type: m.type || "http", name: m.name, interval: m.interval || 60, retryInterval: 60, maxretries: 3, accepted_statuscodes: ["200-299"] };',
    "    if (m.url) data.url = m.url;",
    "    if (m.hostname) data.hostname = m.hostname;",
    "    if (m.port) data.port = m.port;",
    "    if (m.keyword) data.keyword = m.keyword;",
    "    if (m.connectionString) data.databaseConnectionString = m.connectionString;",
    "    if (m.dnsResolveType) data.dns_resolve_type = m.dnsResolveType;",
    "    if (m.dnsResolveServer) data.dns_resolve_server = m.dnsResolveServer;",
    "    if (m.grpcServiceName) data.grpcServiceName = m.grpcServiceName;",
    '    if (["http","keyword","json-query"].includes(data.type)) data.accepted_statuscodes = ["200-299"];',
    "    if (m.extra) Object.assign(data, m.extra);",
    "    if (m.group && groupIds[m.group]) data.parent = groupIds[m.group];",
    '    const res = await new Promise(resolve => socket.emit("add", data, resolve));',
    "    if (res.ok) byName[m.name] = res.monitorID;",
    '    console.log(res.ok ? "  OK" : "  FAIL: " + res.msg);',
    "  }",
    "  socket.disconnect();",
    "}",
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
                containers: [
                  {
                    name: "reconciler",
                    image: "node:22-alpine",
                    command: [
                      "sh",
                      "-c",
                      "cd /tmp && npm init -y > /dev/null 2>&1 && npm install --no-package-lock socket.io-client > /dev/null 2>&1 && NODE_PATH=/tmp/node_modules node /scripts/reconcile.js",
                    ],
                    env: [
                      {
                        name: "KUMA_USERNAME",
                        valueFrom: { secretKeyRef: { name: "kuma-credentials", key: "username" } },
                      },
                      {
                        name: "KUMA_PASSWORD",
                        valueFrom: { secretKeyRef: { name: "kuma-credentials", key: "password" } },
                      },
                      {
                        name: "KUMA_URL",
                        value: release.status.apply(
                          (s) =>
                            `http://${s?.name ?? "uptime-kuma"}.${ukNamespace}.svc.cluster.local:3001`
                        ),
                      },
                    ],
                    volumeMounts: [{ name: "script", mountPath: "/scripts" }],
                  },
                ],
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
      roleRef: {
        apiGroup: "rbac.authorization.k8s.io",
        kind: "ClusterRole",
        name: "kuma-monitor-reader",
      },
      subjects: [{ kind: "ServiceAccount", name: "kuma-reconciler", namespace: ukNamespace }],
    },
    { provider }
  );

  return release;
}
