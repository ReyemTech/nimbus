/**
 * Observability stack implementation — deploys Prometheus, Grafana, Loki,
 * Alloy, and Alertmanager as a cohesive monitoring/logging stack.
 *
 * @module observability/stack
 */

import * as k8s from "@pulumi/kubernetes";
import type {
  IAlertmanagerConfig,
  IAlloyConfig,
  IGrafanaConfig,
  ILokiConfig,
  IObservabilityStack,
  IObservabilityStackConfig,
  IPrometheusConfig,
} from "./interfaces";

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

  if (prometheusEnabled || grafanaEnabled || alertmanagerEnabled) {
    components["kube-prometheus-stack"] = deployKubePrometheusStack(
      name,
      namespace,
      config.domain,
      config.prometheus,
      config.grafana,
      config.alertmanager,
      provider
    );
  }

  // 3. Loki (log aggregation)
  if (config.loki?.enabled) {
    components["loki"] = deployLoki(name, namespace, config.loki, provider);
  }

  // 4. Alloy (log/metric collector)
  if (config.alloy?.enabled) {
    components["alloy"] = deployAlloy(name, namespace, config.alloy, provider);
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
  provider: k8s.Provider
): k8s.helm.v3.Release {
  const certName = domain.replace(/\./g, "-");
  const tlsSecretName = `${certName}-wildcard-tls`;

  // Prometheus values
  const prometheusValues: Record<string, unknown> = {
    enabled: prometheus?.enabled ?? false,
  };
  if (prometheus?.enabled) {
    const promSubdomain = prometheus.subdomain ?? "prometheus";
    prometheusValues["prometheusSpec"] = {
      retention: prometheus.retention ?? "15d",
      storageSpec: {
        volumeClaimTemplate: {
          spec: {
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

    // Dashboard sidecar for configmap-based persistence
    if ((grafana.dashboardPersistence ?? "configmap") === "configmap") {
      grafanaValues["sidecar"] = {
        dashboards: {
          enabled: true,
          searchNamespace: "ALL",
          label: "grafana_dashboard",
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
  provider: k8s.Provider
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
    lokiValues["singleBinary"]["persistence"] = {
      enabled: true,
      size: `${storageGb}Gi`,
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
  provider: k8s.Provider
): k8s.helm.v3.Release {
  return new k8s.helm.v3.Release(
    `${name}-alloy`,
    {
      chart: "alloy",
      repositoryOpts: { repo: "https://grafana.github.io/helm-charts" },
      version: config.version ?? DEFAULT_VERSIONS.alloy,
      namespace,
      createNamespace: false,
      values: {
        ...config.values,
      },
    },
    { provider }
  );
}
