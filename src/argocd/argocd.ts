/**
 * ArgoCD class — main entry point for the ArgoCD module.
 *
 * Registry-backed: all projects, repos, and apps are queryable.
 * Reads nimbus.notifications for ArgoCD Notifications config.
 *
 * @module argocd/argocd
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { ICluster } from "../cluster";
import type {
  IArgoCDConfig,
  IArgoRepoConfig,
  IArgoRepoRef,
  IArgoProjectConfig,
  IArgoAppConfig,
} from "./interfaces";
import type { IExposedService } from "../types";
import { createArgoRepo } from "./repo";
import { ArgoProject } from "./project";
import { ArgoApp } from "./app";
import { nimbus } from "../nimbus";

export class ArgoCD {
  readonly name: string;
  private readonly cluster: ICluster;
  private readonly provider: k8s.Provider;
  private readonly helmRelease: k8s.helm.v3.Release;

  private readonly repoRegistry = new Map<string, IArgoRepoRef>();
  private readonly projectRegistry = new Map<string, ArgoProject>();
  private readonly appRegistry = new Map<string, ArgoApp>();

  constructor(name: string, config: IArgoCDConfig) {
    this.name = name;
    this.cluster = config.cluster;
    this.provider = config.cluster.provider;
    this.helmRelease = config.helmRelease;

    // Configure ArgoCD Notifications from nimbus singleton
    this.configureNotifications();
  }

  // --- Repos ---

  addRepo(name: string, config: IArgoRepoConfig): IArgoRepoRef {
    if (this.repoRegistry.has(name)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- checked by has() above
      return this.repoRegistry.get(name)!;
    }
    const ref = createArgoRepo(this.name, name, config, this.provider, [this.helmRelease]);
    this.repoRegistry.set(name, ref);
    return ref;
  }

  repo(name: string): IArgoRepoRef {
    const ref = this.repoRegistry.get(name);
    if (!ref) {
      throw new Error(`Repo "${name}" not found. Registered: ${[...this.repoRegistry.keys()].join(", ") || "(none)"}`);
    }
    return ref;
  }

  // --- Projects ---

  createProject(name: string, config: IArgoProjectConfig = {}): ArgoProject {
    if (this.projectRegistry.has(name)) {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- checked by has() above
      return this.projectRegistry.get(name)!;
    }
    const project = new ArgoProject(
      this.name,
      name,
      config,
      this.provider,
      [this.helmRelease],
      (appName, appConfig, proj) => this.internalCreateApp(appName, appConfig, proj)
    );
    this.projectRegistry.set(name, project);
    return project;
  }

  project(name: string): ArgoProject {
    const project = this.projectRegistry.get(name);
    if (!project) {
      throw new Error(`Project "${name}" not found. Registered: ${[...this.projectRegistry.keys()].join(", ") || "(none)"}`);
    }
    return project;
  }

  // --- Apps ---

  createApp(name: string, config: IArgoAppConfig): ArgoApp {
    const projectName = config.project ?? "default";
    if (!this.projectRegistry.has(projectName) && projectName !== "default") {
      throw new Error(`Project "${projectName}" not found. Create it first with createProject().`);
    }
    return this.internalCreateApp(name, config);
  }

  app(name: string): ArgoApp {
    const app = this.appRegistry.get(name);
    if (!app) {
      throw new Error(`App "${name}" not found. Registered: ${[...this.appRegistry.keys()].join(", ") || "(none)"}`);
    }
    return app;
  }

  apps(): ReadonlyArray<ArgoApp> {
    return [...this.appRegistry.values()];
  }

  // --- Exposed services ---

  get exposedServices(): ReadonlyArray<IExposedService> {
    return [...this.appRegistry.values()]
      .map((app) => app.getExposedService())
      .filter((s): s is IExposedService => s !== undefined);
  }

  // --- Internal ---

  private internalCreateApp(name: string, config: IArgoAppConfig, project?: ArgoProject): ArgoApp {
    if (this.appRegistry.has(name)) {
      throw new Error(`App "${name}" already exists`);
    }

    // Handle inline children (App-of-Apps)
    if ("children" in config.source) {
      const children = config.source.children;
      for (const child of children) {
        const childConfig: IArgoAppConfig = {
          project: config.project,
          source: child.source,
          namespace: child.namespace,
          syncPolicy: child.syncPolicy ?? config.syncPolicy,
        };
        this.internalCreateApp(child.name, childConfig);
      }
    }

    const dependsOn: pulumi.Resource[] = [this.helmRelease];
    if (project) {
      dependsOn.push(project.resource);
    }

    const app = new ArgoApp(this.name, name, config, this.cluster, this.provider, dependsOn);
    this.appRegistry.set(name, app);

    return app;
  }

  private configureNotifications(): void {
    const notifications = nimbus.notifications;
    if (!notifications?.email) return;

    const transport = notifications.email.transport;
    // ArgoCD Notifications ConfigMap — templates + triggers
    new k8s.core.v1.ConfigMap(
      `${this.name}-argocd-notifications-cm`,
      {
        metadata: { name: "argocd-notifications-cm", namespace: "argocd" },
        data: {
          "service.email": pulumi
            .all([transport.host, transport.port, transport.username])
            .apply(
              ([host, port, username]) =>
                `host: ${host}\nport: ${port}\nusername: ${username}\nfrom: ${transport.fromAddress}\n`
            ),
          "trigger.on-sync-failed": "- when: app.status.sync.status == 'OutOfSync' and app.status.operationState.phase == 'Failed'\n  send: [app-sync-failed]",
          "trigger.on-health-degraded": "- when: app.status.health.status == 'Degraded'\n  send: [app-health-degraded]",
          "trigger.on-sync-succeeded": "- when: app.status.operationState.phase == 'Succeeded'\n  send: [app-sync-succeeded]",
          "template.app-sync-failed": `message: |\n  Application {{.app.metadata.name}} sync failed.\n  Sync Status: {{.app.status.sync.status}}\n  Health: {{.app.status.health.status}}`,
          "template.app-health-degraded": `message: |\n  Application {{.app.metadata.name}} health degraded.\n  Health: {{.app.status.health.status}}`,
          "template.app-sync-succeeded": `message: |\n  Application {{.app.metadata.name}} synced successfully.\n  Revision: {{.app.status.sync.revision}}`,
          "defaultTriggers": "- on-sync-failed\n- on-health-degraded",
        },
      },
      { provider: this.provider, dependsOn: [this.helmRelease] }
    );

    // ArgoCD Notifications Secret — SMTP password
    new k8s.core.v1.Secret(
      `${this.name}-argocd-notifications-secret`,
      {
        metadata: { name: "argocd-notifications-secret", namespace: "argocd" },
        stringData: {
          "email-password": transport.password,
        },
      },
      { provider: this.provider, dependsOn: [this.helmRelease] }
    );
  }
}
