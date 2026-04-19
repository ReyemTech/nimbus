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
  if (source.values || source.valuesFiles || source.releaseName) {
    const helm: Record<string, unknown> = {};
    if (source.values) {
      helm["valuesObject"] = source.values;
    }
    if (source.valuesFiles) {
      helm["valueFiles"] = source.valuesFiles;
    }
    if (source.releaseName) {
      helm["releaseName"] = source.releaseName;
    }
    spec["helm"] = helm;
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

    // Write monitor definitions to shared ConfigMap for Uptime Kuma reconciler
    if (config.monitors?.length) {
      const monitors = config.monitors.map((m) => {
        const displayName =
          m.name ??
          (m.url ? `${name} — ${new URL(m.url).hostname}` : `${name} — ${m.hostname}:${m.port}`);
        return {
          name: displayName,
          url: m.url,
          hostname: m.hostname,
          port: m.port,
          type: m.type ?? "http",
          keyword: m.keyword,
          interval: m.interval ?? 60,
          group: m.group ?? this.project,
          connectionString: m.connectionString,
          dnsResolveType: m.dnsResolveType,
          dnsResolveServer: m.dnsResolveServer,
          grpcServiceName: m.grpcServiceName,
          extra: m.extra,
        };
      });

      new k8s.core.v1.ConfigMap(
        `${resourceName}-monitors-${name}`,
        {
          metadata: {
            name: `kuma-monitors-${name}`,
            namespace: "uptime-kuma",
            labels: {
              "app.kubernetes.io/managed-by": "nimbus",
              "nimbus/component": "uptime-kuma-monitor",
              "nimbus/app": name,
            },
          },
          data: {
            "monitors.json": JSON.stringify(monitors, null, 2),
          },
        },
        { provider, dependsOn: [this.resource] }
      );
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
