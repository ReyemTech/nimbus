/**
 * Platform stack interfaces for @reyemtech/nimbus.
 *
 * Cloud-agnostic platform components deployed via Helm to any ICluster.
 * These are the components used across all 3 client environments:
 * Traefik, ArgoCD, cert-manager, External DNS, Vault, External Secrets.
 *
 * @module platform/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type * as k8s from "@pulumi/kubernetes";
import type { ICluster } from "../cluster";

/** DNS provider for External DNS integration. */
export type DnsProvider =
  | "route53" // AWS Route 53 (ReyemTech + DoNotCarry)
  | "azure-dns" // Azure DNS Zone (MetrixGroup)
  | "cloud-dns" // GCP Cloud DNS
  | "cloudflare"; // Cloudflare DNS

/** Individual platform component configuration. */
export interface IPlatformComponentConfig {
  /** Enable or disable this component. Default: true for core components. */
  readonly enabled?: boolean;
  /** Helm chart version override. */
  readonly version?: string;
  /** Additional Helm values to merge with defaults. */
  readonly values?: Readonly<Record<string, unknown>>;
}

/** External DNS component configuration with provider-specific auth. */
export interface IExternalDnsConfig extends IPlatformComponentConfig {
  readonly dnsProvider: DnsProvider;
  /** Provider-specific credentials (e.g., AWS IAM keys, Azure identity). */
  readonly dnsCredentials?: Record<string, pulumi.Input<string>>;
  /** DNS zone filter (e.g., ["reyem.tech"]). */
  readonly domainFilters?: ReadonlyArray<string>;
}

/** Vault component configuration. */
export interface IVaultConfig extends IPlatformComponentConfig {
  /** Enable HA mode. Default: false (single node). */
  readonly ha?: boolean;
  /** Storage size for Vault data. Default: "5Gi". */
  readonly storageSize?: string;
  /** Domain for Vault ingress (e.g., "vault.reyem.tech"). */
  readonly ingressHost?: string;
}

/** Image pull secret configuration for private registries. */
export interface IImagePullSecret {
  readonly registry: string;
  readonly username: pulumi.Input<string>;
  readonly password: pulumi.Input<string>;
  readonly email?: pulumi.Input<string>;
  /** Namespaces to replicate the pull secret into. */
  readonly namespaces?: ReadonlyArray<string>;
}

/** Descheduler configuration for spot/preemptible environments. */
export interface IDeschedulerConfig extends IPlatformComponentConfig {
  /** Strategies to enable. Default: RemoveDuplicates, LowNodeUtilization, RemovePodsViolatingNodeAffinity */
  readonly strategies?: ReadonlyArray<string>;
}

/**
 * Platform stack configuration input.
 *
 * @example
 * ```typescript
 * const config: IPlatformStackConfig = {
 *   cluster,
 *   domain: "reyem.tech",
 *   externalDns: {
 *     dnsProvider: "route53",
 *     domainFilters: ["reyem.tech"],
 *   },
 *   vault: { enabled: true, ingressHost: "vault.reyem.tech" },
 * };
 * ```
 */
export interface IPlatformStackConfig {
  readonly cluster: ICluster | ReadonlyArray<ICluster>;
  readonly domain: string;

  /** Core components (enabled by default). */
  readonly traefik?: IPlatformComponentConfig;
  readonly certManager?: IPlatformComponentConfig;
  readonly externalDns?: IExternalDnsConfig;

  /** Optional components. */
  readonly argocd?: IPlatformComponentConfig;
  readonly vault?: IVaultConfig;
  readonly externalSecrets?: IPlatformComponentConfig;
  readonly oauth2Proxy?: IPlatformComponentConfig & {
    readonly provider: "google" | "github" | "azure";
    readonly clientId: pulumi.Input<string>;
    readonly clientSecret: pulumi.Input<string>;
  };

  /** Block robots/crawlers on staging environments. Default: false. */
  readonly robotsBlock?: boolean;

  /** Private registry image pull secrets, replicated to specified namespaces. */
  readonly imagePullSecrets?: ReadonlyArray<IImagePullSecret>;

  /** Descheduler for pod rebalancing on spot instances. */
  readonly descheduler?: IDeschedulerConfig;

  readonly tags?: Readonly<Record<string, string>>;
}

/**
 * Platform stack output — the deployed platform components.
 *
 * Each component is accessible as a Helm release for further customization.
 */
export interface IPlatformStack {
  readonly name: string;
  readonly cluster: ICluster;
  readonly components: Readonly<Record<string, k8s.helm.v3.Release>>;
  readonly traefikEndpoint: pulumi.Output<string>;
}
