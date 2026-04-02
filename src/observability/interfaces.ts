/**
 * Observability stack interfaces for @reyemtech/nimbus.
 *
 * Defines configuration for Prometheus, Grafana, Loki, Alloy, and
 * Alertmanager deployed as a cohesive monitoring/logging stack.
 *
 * @module observability/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type * as k8s from "@pulumi/kubernetes";
import type { ICluster } from "../cluster";
import type { StorageTier } from "../types/storage-tiers";
import type { IEmailTransport } from "../email/interfaces";
import type { IExposedService } from "../types";

// ---------------------------------------------------------------------------
// Alerting interfaces
// ---------------------------------------------------------------------------

/** Email alert notification config — uses an IEmailTransport for SMTP. */
export interface IAlertEmailConfig {
  /** Recipient email address(es). */
  readonly to: string | string[];
  /** Email transport providing SMTP credentials. */
  readonly transport: IEmailTransport;
}

/** Slack alert notification config. */
export interface IAlertSlackConfig {
  /** K8s Secret name containing the Slack webhook URL (key: "webhook-url"). */
  readonly webhookUrlSecret: string;
  /** Slack channel (e.g., "#alerts"). */
  readonly channel: string;
  /** Bot username. Default: "Nimbus Alerts". */
  readonly username?: string;
}

/** Top-level alerting configuration for the observability stack. */
export interface IAlertConfig {
  /** Email notification receiver. */
  readonly email?: IAlertEmailConfig;
  /** Slack notification receiver. */
  readonly slack?: IAlertSlackConfig;
}

/** Prometheus server configuration. */
export interface IPrometheusConfig {
  /** Enable the Prometheus server. */
  readonly enabled: boolean;
  /** Expose via access gateway (Tailscale). Default: true. */
  readonly expose?: boolean;
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
  /** Expose via access gateway (Tailscale). Default: true. */
  readonly expose?: boolean;
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
  /** Log retention period (e.g., "7d", "30d"). Default: no compactor retention. */
  readonly retention?: string;
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
  /** Expose via access gateway (Tailscale). Default: true. */
  readonly expose?: boolean;
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
  /** Alerting configuration: notification receivers and rule thresholds. */
  readonly alerts?: IAlertConfig;
  /** Neo4j Bolt endpoint for Grafana datasource (e.g., "bolt://neo4j-main.data.svc.cluster.local:7687"). */
  readonly neo4jEndpoint?: pulumi.Input<string>;
  /** Neo4j admin password secret name (must have a "password" key in the data namespace). */
  readonly neo4jPasswordSecret?: string;
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
  /** Services available for access gateway exposure. */
  readonly exposedServices: ReadonlyArray<IExposedService>;
}
