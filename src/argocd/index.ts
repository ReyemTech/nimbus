/**
 * ArgoCD module — fluent API for managing ArgoCD Applications.
 *
 * @module argocd
 */

import type { IArgoCDConfig } from "./interfaces";
import { ArgoCD } from "./argocd";

export { ArgoCD } from "./argocd";
export { ArgoProject } from "./project";
export { ArgoApp } from "./app";
export { createAppSecrets } from "./secrets";
export { createExternalSecrets } from "./external-secrets";

export type {
  ArgoRepoType,
  IArgoRepoConfig,
  IArgoGitSshRepoConfig,
  IArgoGitHttpsRepoConfig,
  IArgoHelmRepoConfig,
  IArgoOciRepoConfig,
  IArgoRepoRef,
  IArgoAppSource,
  IArgoRepoSource,
  IArgoPublicSource,
  IArgoChildrenSource,
  IArgoSyncPolicy,
  IArgoProjectConfig,
  IArgoAppConfig,
  IArgoAppMonitor,
  KumaMonitorType,
  IArgoSecretsConfig,
  IArgoAppSecrets,
  IArgoCDConfig,
  IExternalSecretsConfig,
  IExternalSecretDataRef,
  IExternalSecretDataFromRef,
} from "./interfaces";

/**
 * Create an ArgoCD management instance.
 */
export function createArgoCD(name: string, config: IArgoCDConfig): ArgoCD {
  return new ArgoCD(name, config);
}
