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
