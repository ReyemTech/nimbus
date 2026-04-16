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
import type { IExposedService } from "../types";

/** DNS provider for External DNS integration. */
export type DnsProvider =
  | "route53" // AWS Route 53 (ReyemTech + DoNotCarry)
  | "azure-dns" // Azure DNS Zone (MetrixGroup)
  | "cloud-dns" // GCP Cloud DNS
  | "cloudflare"; // Cloudflare DNS

/** Typed constant map for DnsProvider string literals. */
export const DNS_PROVIDERS = {
  ROUTE53: "route53" as const,
  AZURE_DNS: "azure-dns" as const,
  CLOUD_DNS: "cloud-dns" as const,
  CLOUDFLARE: "cloudflare" as const,
} satisfies Record<string, DnsProvider>;

/** Individual platform component configuration. */
export interface IPlatformComponentConfig {
  /** Enable or disable this component. Default: true for core components. */
  readonly enabled?: boolean;
  /** Expose via access gateway (Tailscale). Default: true. */
  readonly expose?: boolean;
  /** Helm chart version override. */
  readonly version?: string;
  /** Additional Helm values to merge with defaults. */
  readonly values?: Readonly<Record<string, unknown>>;
}

/** External DNS component configuration with provider-specific auth. */
export interface IExternalDnsConfig extends IPlatformComponentConfig {
  readonly dnsProvider: DnsProvider;
  /** AWS region for Route53. Required when dnsProvider is "route53". */
  readonly awsRegion?: string;
  /** Explicit AWS provider for Route53 IAM resources. If not provided, uses default. */
  readonly awsProvider?: pulumi.ProviderResource;
  /**
   * Manual credentials override. If provided, nimbus uses these instead of
   * creating IAM resources. Useful for non-AWS providers or pre-existing credentials.
   */
  readonly dnsCredentials?: Record<string, pulumi.Input<string>>;
  /** DNS zone filter (e.g., ["reyem.tech"]). */
  readonly domainFilters?: ReadonlyArray<string>;
}

/** AWS KMS auto-unseal configuration. */
export interface IAwsKmsUnsealConfig {
  readonly provider: "awskms";
  /** AWS region for the KMS key. */
  readonly region: string;
  /** Explicit AWS provider for KMS + IAM resources. */
  readonly awsProvider: pulumi.ProviderResource;
  /** Use an existing KMS key instead of creating one. */
  readonly kmsKeyId?: pulumi.Input<string>;
}

/** Azure Key Vault auto-unseal configuration (not yet implemented). */
export interface IAzureKeyVaultUnsealConfig {
  readonly provider: "azurekeyvault";
  readonly tenantId: pulumi.Input<string>;
  readonly vaultName: pulumi.Input<string>;
  readonly keyName: pulumi.Input<string>;
}

/** GCP Cloud KMS auto-unseal configuration (not yet implemented). */
export interface IGcpCkmsUnsealConfig {
  readonly provider: "gcpckms";
  readonly project: pulumi.Input<string>;
  readonly region: string;
  readonly keyRing: pulumi.Input<string>;
  readonly cryptoKey: pulumi.Input<string>;
}

/** Auto-unseal configuration — discriminated union on provider. */
export type IAutoUnsealConfig =
  | IAwsKmsUnsealConfig
  | IAzureKeyVaultUnsealConfig
  | IGcpCkmsUnsealConfig;

/** Vault component configuration. */
export interface IVaultConfig extends IPlatformComponentConfig {
  /** Enable HA mode. Default: false (single node). */
  readonly ha?: boolean;
  /** Storage size for Vault data. Default: "5Gi". */
  readonly storageSize?: string;
  /** Domain for Vault ingress (e.g., "vault.reyem.tech"). */
  readonly ingressHost?: string;
  /** Expose via access gateway (Tailscale). Default: true. */
  readonly expose?: boolean;
  /** Auto-unseal via cloud KMS. Creates KMS key + IAM + credentials. */
  readonly autoUnseal?: IAutoUnsealConfig;
  /** Deploy bootstrap sidecar (init, KV-v2, K8s auth, ESO policy/role). Default: true. */
  readonly bootstrap?: boolean;
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

  /** Per-node image cache pruner. Default: { enabled: true, intervalSeconds: 21600 }. */
  readonly imagePruner?: IImagePrunerConfig;

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
  /** Services available for access gateway exposure. */
  readonly exposedServices: ReadonlyArray<IExposedService>;
}

/**
 * Per-Container LimitRange defaults applied when a pod does not declare its own.
 * Both fields are required to avoid partial-merge ambiguity at admission time.
 */
export interface ILimitRangePolicy {
  readonly defaultRequest: {
    readonly cpu?: string;
    readonly memory?: string;
    readonly ephemeralStorage?: string;
  };
  readonly defaultLimit: {
    readonly cpu?: string;
    readonly memory?: string;
    readonly ephemeralStorage?: string;
  };
}

/**
 * Namespace-scoped policy attached at namespace creation time.
 * Pass `false` (whole policy) or `{ limitRange: false }` to opt out.
 */
export interface INamespacePolicy {
  readonly limitRange?: ILimitRangePolicy | false;
}

/**
 * Default policy applied to every namespace created via ensureNamespace
 * unless explicitly overridden.
 *
 * CPU/memory deliberately omitted: apps already declare these, and silently
 * capping them would cause throttling/OOM with no warning.
 */
export const DEFAULT_NAMESPACE_POLICY: INamespacePolicy = {
  limitRange: {
    defaultRequest: { ephemeralStorage: "500Mi" },
    defaultLimit: { ephemeralStorage: "2Gi" },
  },
};

/**
 * Namespaces that NEVER get a LimitRange, even if a policy is explicitly passed.
 * These are managed by cluster operators and should not be subject to user-tier
 * resource policy.
 */
export const SYSTEM_NAMESPACES: ReadonlySet<string> = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "calico-system",
  "calico-apiserver",
  "tigera-operator",
  "projectsveltos",
]);

/** Image-cache pruner DaemonSet configuration. */
export interface IImagePrunerConfig {
  /** Enable the pruner DaemonSet. Default: true. */
  readonly enabled?: boolean;
  /** Prune interval in seconds. Default: 21600 (6h). */
  readonly intervalSeconds?: number;
  /** Base image. Default: "alpine:3.20" (crictl downloaded at pod start). */
  readonly image?: string;
  /** Namespace for the DaemonSet. Default: "kube-system". */
  readonly namespace?: string;
}
