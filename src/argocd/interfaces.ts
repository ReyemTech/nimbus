/**
 * ArgoCD module interfaces for @reyemtech/nimbus.
 *
 * @module argocd/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type * as k8s from "@pulumi/kubernetes";
import type { ICluster } from "../cluster";

// ---------------------------------------------------------------------------
// Repo
// ---------------------------------------------------------------------------

/** Repository credential types. */
export type ArgoRepoType = "git" | "helm" | "oci";

/** Git repo via SSH. */
export interface IArgoGitSshRepoConfig {
  readonly type: "git";
  readonly url: string;
  readonly sshPrivateKey: pulumi.Input<string>;
}

/** Git repo via HTTPS. */
export interface IArgoGitHttpsRepoConfig {
  readonly type: "git";
  readonly url: string;
  readonly username: pulumi.Input<string>;
  readonly password: pulumi.Input<string>;
}

/** Helm repo with optional auth. */
export interface IArgoHelmRepoConfig {
  readonly type: "helm";
  readonly url: string;
  readonly username?: pulumi.Input<string>;
  readonly password?: pulumi.Input<string>;
}

/** OCI registry with auth. */
export interface IArgoOciRepoConfig {
  readonly type: "oci";
  readonly url: string;
  readonly username: pulumi.Input<string>;
  readonly password: pulumi.Input<string>;
}

export type IArgoRepoConfig =
  | IArgoGitSshRepoConfig
  | IArgoGitHttpsRepoConfig
  | IArgoHelmRepoConfig
  | IArgoOciRepoConfig;

// ---------------------------------------------------------------------------
// Source
// ---------------------------------------------------------------------------

/** Source using a registered repo — type inferred from repo. */
export interface IArgoRepoSource {
  readonly repo: IArgoRepoRef;
  readonly chart?: string;
  readonly path?: string;
  readonly version?: string;
  readonly revision?: string;
  readonly values?: Record<string, unknown>;
  readonly releaseName?: string;
}

/** Source using a public repo URL — no addRepo() needed. */
export interface IArgoPublicSource {
  readonly repoURL: string;
  readonly chart?: string;
  readonly path?: string;
  readonly version?: string;
  readonly revision?: string;
  readonly values?: Record<string, unknown>;
  readonly releaseName?: string;
}

/** Inline App-of-Apps children. */
export interface IArgoChildrenSource {
  readonly children: ReadonlyArray<{
    readonly name: string;
    readonly source: IArgoAppSource;
    readonly namespace: string;
    readonly syncPolicy?: IArgoSyncPolicy;
  }>;
}

export type IArgoAppSource = IArgoRepoSource | IArgoPublicSource | IArgoChildrenSource;

// ---------------------------------------------------------------------------
// Sync Policy
// ---------------------------------------------------------------------------

export interface IArgoSyncPolicy {
  readonly automated?: boolean;
  readonly selfHeal?: boolean;
  readonly prune?: boolean;
  readonly syncOptions?: ReadonlyArray<string>;
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export interface IArgoProjectConfig {
  readonly description?: string;
  readonly allowedNamespaces?: ReadonlyArray<string>;
  readonly sourceRepos?: ReadonlyArray<string>;
  readonly destinations?: ReadonlyArray<{
    readonly server: string;
    readonly namespace: string;
  }>;
  readonly clusterResourceBlacklist?: ReadonlyArray<{
    readonly group: string;
    readonly kind: string;
  }>;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

/** Supported Uptime Kuma monitor types. */
export type KumaMonitorType =
  | "http" // HTTP(s) status check
  | "keyword" // HTTP(s) + keyword match in response body
  | "json-query" // HTTP(s) + JSON path query
  | "tcp" // TCP port check
  | "dns" // DNS record check
  | "grpc" // gRPC health check
  | "mysql" // MySQL/MariaDB connection check
  | "postgres" // PostgreSQL connection check
  | "redis" // Redis connection check
  | "mongodb" // MongoDB connection check
  | "mqtt" // MQTT broker check
  | "rabbitmq" // RabbitMQ management API check
  | "smtp" // SMTP server check
  | "group" // Monitor group (container for child monitors)
  | "push" // Push-based (passive heartbeat)
  | "gamedig" // GameDig game server check
  | "docker" // Docker container check
  | "snmp" // SNMP check
  | "tailscale-ping"; // Tailscale ICMP ping

/** Uptime monitor definition for auto-registration. */
export interface IArgoAppMonitor {
  /** Display name. Defaults to "{appName} — {hostname}". */
  readonly name?: string;
  /** URL or hostname to monitor. */
  readonly url?: string;
  /** Hostname for non-URL monitors (tcp, mysql, postgres, redis, etc). */
  readonly hostname?: string;
  /** Port for TCP/database monitors. */
  readonly port?: number;
  /** Monitor type. Default: "http". */
  readonly type?: KumaMonitorType;
  /** Expected keyword in response body (for keyword type). */
  readonly keyword?: string;
  /** Check interval in seconds. Default: 60. */
  readonly interval?: number;
  /** Monitor group name. Defaults to the ArgoCD project name. */
  readonly group?: string;
  /** Database connection string (for mysql, postgres, redis, mongodb). */
  readonly connectionString?: string;
  /** DNS resolve type (for dns type): A, AAAA, CNAME, MX, TXT, etc. */
  readonly dnsResolveType?: string;
  /** DNS resolve server (for dns type). */
  readonly dnsResolveServer?: string;
  /** GRPC service name (for grpc type). */
  readonly grpcServiceName?: string;
  /** Additional Kuma-specific properties passed directly. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export interface IArgoAppConfig {
  readonly project?: string;
  readonly source: IArgoAppSource;
  readonly namespace: string;
  readonly syncPolicy?: IArgoSyncPolicy;
  readonly dashboard?: boolean;
  readonly notifications?: {
    readonly onSyncSucceeded?: boolean;
    readonly onSyncFailed?: boolean;
    readonly onHealthDegraded?: boolean;
  };
  /** Uptime monitors to register in Uptime Kuma. */
  readonly monitors?: ReadonlyArray<IArgoAppMonitor>;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

export interface IArgoSecretField {
  readonly random?: number;
  readonly value?: pulumi.Input<string>;
}

export type IArgoSecretsConfig = Record<string, IArgoSecretField>;

export interface IArgoAppSecrets {
  readonly name: string;
  ref(key: string): { secretKeyRef: { name: string; key: string } };
}

// ---------------------------------------------------------------------------
// External Secrets (ESO)
// ---------------------------------------------------------------------------

/** Individual secret key mapping: Vault path + property → K8s Secret key. */
export interface IExternalSecretDataRef {
  readonly key: string;
  readonly property?: string;
}

/** Bulk pull: all keys from a Vault path. */
export interface IExternalSecretDataFromRef {
  readonly key: string;
}

/** ExternalSecret configuration. */
export interface IExternalSecretsConfig {
  /** Individual key mappings (K8s Secret key → Vault remoteRef). */
  readonly data?: Record<string, IExternalSecretDataRef>;
  /** Bulk pull all keys from Vault paths. */
  readonly dataFrom?: ReadonlyArray<IExternalSecretDataFromRef>;
  /** ClusterSecretStore name. Default: "vault-backend". */
  readonly store?: string;
  /** Refresh interval. Default: "1h". */
  readonly refreshInterval?: string;
}

// ---------------------------------------------------------------------------
// Refs (returned by registry lookups)
// ---------------------------------------------------------------------------

/** Reference to a registered repo — carries type + URL for source inference. */
export interface IArgoRepoRef {
  readonly name: string;
  readonly type: ArgoRepoType;
  readonly url: string;
}

// ---------------------------------------------------------------------------
// Factory config
// ---------------------------------------------------------------------------

export interface IArgoCDConfig {
  readonly cluster: ICluster;
  readonly helmRelease: k8s.helm.v3.Release;
}
