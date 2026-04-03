/**
 * ArgoCD AppProject management.
 *
 * @module argocd/project
 */

import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import type { IArgoProjectConfig, IArgoAppConfig } from "./interfaces";
import type { ArgoApp } from "./app";

const ARGOCD_NAMESPACE = "argocd";

export class ArgoProject {
  readonly name: string;
  readonly resource: k8s.apiextensions.CustomResource;
  private readonly appRegistry = new Map<string, ArgoApp>();
  private readonly createAppFn: (name: string, config: IArgoAppConfig, project: ArgoProject) => ArgoApp;

  constructor(
    resourceName: string,
    name: string,
    config: IArgoProjectConfig,
    provider: k8s.Provider,
    dependsOn: pulumi.Resource[],
    createAppFn: (name: string, config: IArgoAppConfig, project: ArgoProject) => ArgoApp
  ) {
    this.name = name;
    this.createAppFn = createAppFn;

    // Build project spec
    const destinations = config.destinations ?? [
      { server: "https://kubernetes.default.svc", namespace: "*" },
    ];
    const sourceRepos = config.sourceRepos ?? ["*"];

    const spec: Record<string, unknown> = {
      description: config.description ?? "",
      sourceRepos,
      destinations,
    };

    if (config.clusterResourceBlacklist) {
      spec["clusterResourceBlacklist"] = config.clusterResourceBlacklist;
    }

    this.resource = new k8s.apiextensions.CustomResource(
      `${resourceName}-project-${name}`,
      {
        apiVersion: "argoproj.io/v1alpha1",
        kind: "AppProject",
        metadata: { name, namespace: ARGOCD_NAMESPACE },
        spec,
      },
      { provider, dependsOn }
    );
  }

  /** Create an app in this project. */
  createApp(name: string, config: IArgoAppConfig): ArgoApp {
    const appConfig = { ...config, project: this.name };
    const app = this.createAppFn(name, appConfig, this);
    this.appRegistry.set(name, app);
    return app;
  }

  /** Look up an existing app in this project. */
  app(name: string): ArgoApp {
    const app = this.appRegistry.get(name);
    if (!app) {
      throw new Error(`App "${name}" not found in project "${this.name}"`);
    }
    return app;
  }

  /** All apps in this project. */
  apps(): ReadonlyArray<ArgoApp> {
    return [...this.appRegistry.values()];
  }
}
