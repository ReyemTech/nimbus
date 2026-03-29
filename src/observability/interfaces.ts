/**
 * Observability stack interfaces for @reyemtech/nimbus.
 *
 * Defines configuration for Prometheus, Grafana, Loki, Alloy, and
 * Alertmanager deployed as a cohesive monitoring/logging stack.
 *
 * @module observability/interfaces
 */

import type * as k8s from "@pulumi/kubernetes";
import type { ICluster } from "../cluster";
import type { StorageTier } from "../types/storage-tiers";

/** Prometheus server configuration. */
export interface IPrometheusConfig {
  /** Enable the Prometheus server. */
  readonly enabled: boolean;
  /** Data retention period. Default: "15d". */
  readonly retention?: string;
  /** Persistent volume size in GB. Default: 20. */
  readonly storageGb?: number;
  /** Storage performance tier mapped to cluster storage class. */
  readonly storageTier?: StorageTier;
  /** Ingress subdomain prefix. Default: "prometheus". */
  readonly subdomain?: string;
  /** Helm chart version override. */
  readonly version?: string;
  /** Additional Helm values to merge with defaults. */
  readonly values?: Readonly<Record<string, unknown>>;
}

/** Grafana dashboard configuration. */
export interface IGrafanaConfig {
  /** Enable Grafana. */
  readonly enabled: boolean;
  /** Dashboard persistence strategy. Default: "configmap". */
  readonly dashboardPersistence?: "configmap";
  /** Auto-configured datasources. Default: ["prometheus", "loki"]. */
  readonly datasources?: ReadonlyArray<string>;
  /** Persistent volume size in GB for Grafana data. */
  readonly storageGb?: number;
  /** Storage performance tier mapped to cluster storage class. */
  readonly storageTier?: StorageTier;
  /** Ingress subdomain prefix. Default: "grafana". */
  readonly subdomain?: string;
  /** Helm chart version override. */
  readonly version?: string;
  /** Additional Helm values to merge with defaults. */
  readonly values?: Readonly<Record<string, unknown>>;
}

/** Loki log aggregation configuration. */
export interface ILokiConfig {
  /** Enable Loki log aggregation. */
  readonly enabled: boolean;
  /** Deployment topology. Default: "single-binary". */
  readonly mode?: "single-binary" | "distributed";
  /** Persistent volume size in GB. Default: 10. */
  readonly storageGb?: number;
  /** Storage performance tier mapped to cluster storage class. */
  readonly storageTier?: StorageTier;
  /** Helm chart version override. */
  readonly version?: string;
  /** Additional Helm values to merge with defaults. */
  readonly values?: Readonly<Record<string, unknown>>;
}

/** Grafana Alloy (log/metric collector) configuration. */
export interface IAlloyConfig {
  /** Enable Alloy log collector. */
  readonly enabled: boolean;
  /** Helm chart version override. */
  readonly version?: string;
  /** Additional Helm values to merge with defaults. */
  readonly values?: Readonly<Record<string, unknown>>;
}

/** Alertmanager configuration. */
export interface IAlertmanagerConfig {
  /** Enable Alertmanager. */
  readonly enabled: boolean;
  /** Ingress subdomain prefix. Default: "alertmanager". */
  readonly subdomain?: string;
  /** Helm chart version override. */
  readonly version?: string;
  /** Additional Helm values to merge with defaults. */
  readonly values?: Readonly<Record<string, unknown>>;
}

/**
 * Observability stack configuration input.
 *
 * @example
 * ```typescript
 * const config: IObservabilityStackConfig = {
 *   cluster,
 *   domain: "reyem.tech",
 *   prometheus: { enabled: true },
 *   grafana: { enabled: true },
 *   loki: { enabled: true },
 *   alloy: { enabled: true },
 * };
 * ```
 */
export interface IObservabilityStackConfig {
  /** Target cluster for the observability stack. */
  readonly cluster: ICluster;
  /** Base domain for ingress endpoints (e.g., "reyem.tech"). */
  readonly domain: string;
  /** Kubernetes namespace for all observability components. Default: "observability". */
  readonly namespace?: string;
  /** Prometheus server configuration. */
  readonly prometheus?: IPrometheusConfig;
  /** Grafana dashboard configuration. */
  readonly grafana?: IGrafanaConfig;
  /** Loki log aggregation configuration. */
  readonly loki?: ILokiConfig;
  /** Grafana Alloy collector configuration. */
  readonly alloy?: IAlloyConfig;
  /** Alertmanager configuration. */
  readonly alertmanager?: IAlertmanagerConfig;
  /** Resource tags propagated to all components. */
  readonly tags?: Readonly<Record<string, string>>;
}

/**
 * Observability stack output — the deployed monitoring components.
 *
 * Each component is accessible as a Helm release for further customization.
 */
export interface IObservabilityStack {
  /** Stack name prefix used for all resources. */
  readonly name: string;
  /** Cluster the stack was deployed to. */
  readonly cluster: ICluster;
  /** Map of component name to Helm release. */
  readonly components: Readonly<Record<string, k8s.helm.v3.Release>>;
}
