/**
 * ArgoCD Application management.
 *
 * @module argocd/app
 */

import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import type {
  IArgoAppConfig,
  IArgoAppSource,
  IArgoPublicSource,
  IArgoSyncPolicy,
  IArgoSecretsConfig,
  IArgoAppSecrets,
  IArgoRepoRef,
  IExternalSecretsConfig,
} from "./interfaces";
import type { IExposedService } from "../types";
import type { ICluster } from "../cluster";
import { createAppSecrets } from "./secrets";
import { createExternalSecrets } from "./external-secrets";
import { createArgoAppDashboard } from "../observability/dashboards/argocd-app";

const ARGOCD_NAMESPACE = "argocd";

/**
 * Build ArgoCD Application source spec from nimbus source config.
 */
function buildSourceSpec(source: IArgoAppSource): Record<string, unknown> {
  if ("children" in source) {
    throw new Error("Children source should be handled by the ArgoCD class, not buildSourceSpec");
  }

  let repoURL: string;

  if ("repo" in source) {
    repoURL = (source.repo as IArgoRepoRef).url;
  } else {
    repoURL = (source as IArgoPublicSource).repoURL;
  }

  const spec: Record<string, unknown> = {
    repoURL,
  };

  if (source.chart) {
    spec["chart"] = source.chart;
  }
  if (source.version) {
    spec["targetRevision"] = source.version;
  } else if (source.revision) {
    spec["targetRevision"] = source.revision;
  } else {
    spec["targetRevision"] = "HEAD";
  }
  if (source.path) {
    spec["path"] = source.path;
  }
  if (source.values) {
    spec["helm"] = {
      valuesObject: source.values,
      ...(source.releaseName ? { releaseName: source.releaseName } : {}),
    };
  } else if (source.releaseName) {
    spec["helm"] = { releaseName: source.releaseName };
  }

  return spec;
}

/**
 * Build sync policy spec.
 */
function buildSyncPolicySpec(policy?: IArgoSyncPolicy): Record<string, unknown> | undefined {
  if (!policy) return undefined;

  const spec: Record<string, unknown> = {};

  if (policy.automated) {
    spec["automated"] = {
      prune: policy.prune ?? true,
      selfHeal: policy.selfHeal ?? true,
    };
  }

  if (policy.syncOptions) {
    spec["syncOptions"] = policy.syncOptions;
  }

  return spec;
}

export class ArgoApp {
  readonly name: string;
  readonly namespace: string;
  readonly project: string;
  readonly resource: k8s.apiextensions.CustomResource;
  private readonly cluster: ICluster;
  private exposedService?: IExposedService;

  constructor(
    resourceName: string,
    name: string,
    config: IArgoAppConfig,
    cluster: ICluster,
    provider: k8s.Provider,
    dependsOn: pulumi.Resource[]
  ) {
    this.name = name;
    this.namespace = config.namespace;
    this.project = config.project ?? "default";
    this.cluster = cluster;

    const source = buildSourceSpec(config.source);
    const syncPolicy = buildSyncPolicySpec(config.syncPolicy);

    const spec: Record<string, unknown> = {
      project: this.project,
      source,
      destination: {
        server: "https://kubernetes.default.svc",
        namespace: config.namespace,
      },
    };

    if (syncPolicy) {
      spec["syncPolicy"] = syncPolicy;
    }

    // Notification annotations
    const annotations: Record<string, string> = {};
    if (config.notifications?.onSyncFailed !== false) {
      annotations["notifications.argoproj.io/subscribe.on-sync-failed.email"] = "";
    }
    if (config.notifications?.onHealthDegraded !== false) {
      annotations["notifications.argoproj.io/subscribe.on-health-degraded.email"] = "";
    }
    if (config.notifications?.onSyncSucceeded) {
      annotations["notifications.argoproj.io/subscribe.on-sync-succeeded.email"] = "";
    }

    this.resource = new k8s.apiextensions.CustomResource(
      `${resourceName}-app-${name}`,
      {
        apiVersion: "argoproj.io/v1alpha1",
        kind: "Application",
        metadata: {
          name,
          namespace: ARGOCD_NAMESPACE,
          ...(Object.keys(annotations).length > 0 ? { annotations } : {}),
        },
        spec,
      },
      { provider, dependsOn }
    );

    // Auto-generate dashboard (default: true)
    if (config.dashboard !== false) {
      createArgoAppDashboard(name, provider);
    }
  }

  /** Create K8s Secret with typed refs for Helm values. */
  createSecrets(name: string, config: IArgoSecretsConfig): IArgoAppSecrets {
    return createAppSecrets(name, {
      namespace: this.namespace,
      cluster: this.cluster,
      secrets: config,
    });
  }

  /** Create ExternalSecret CRD that ESO syncs from Vault to a K8s Secret. */
  createExternalSecrets(name: string, config: IExternalSecretsConfig): IArgoAppSecrets {
    return createExternalSecrets(name, {
      namespace: this.namespace,
      cluster: this.cluster,
      secrets: config,
    });
  }

  /** Expose this app via the access gateway (Tailscale). */
  expose(config: { label: string; port: number }): this {
    this.exposedService = {
      name: config.label,
      namespace: this.namespace,
      port: config.port,
      label: config.label,
    };
    return this;
  }

  /** Get the exposed service config (if expose() was called). */
  getExposedService(): IExposedService | undefined {
    return this.exposedService;
  }
}
