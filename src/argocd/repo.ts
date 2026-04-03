/**
 * ArgoCD repository credential management.
 *
 * Creates K8s Secrets with argocd.argoproj.io/secret-type: repository label.
 *
 * @module argocd/repo
 */

import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import type { IArgoRepoConfig, IArgoRepoRef } from "./interfaces";

const ARGOCD_NAMESPACE = "argocd";

/**
 * Create an ArgoCD repository credential secret.
 */
export function createArgoRepo(
  resourceName: string,
  name: string,
  config: IArgoRepoConfig,
  provider: k8s.Provider,
  dependsOn?: pulumi.Resource[]
): IArgoRepoRef {
  const secretData: Record<string, pulumi.Input<string>> = {
    type: config.type === "oci" ? "helm" : config.type,
    url: config.url,
  };

  if (config.type === "oci") {
    secretData["enableOCI"] = "true";
  }

  if (config.type === "git" && "sshPrivateKey" in config) {
    secretData["sshPrivateKey"] = config.sshPrivateKey;
  } else if ("username" in config && config.username) {
    secretData["username"] = config.username;
  }

  if ("password" in config && config.password) {
    secretData["password"] = config.password;
  }

  new k8s.core.v1.Secret(
    `${resourceName}-repo-${name}`,
    {
      metadata: {
        name: `argocd-repo-${name}`,
        namespace: ARGOCD_NAMESPACE,
        labels: {
          "argocd.argoproj.io/secret-type": "repository",
          "app.kubernetes.io/managed-by": "nimbus",
        },
      },
      stringData: secretData,
    },
    { provider, dependsOn }
  );

  return {
    name,
    type: config.type,
    url: config.url,
  };
}
