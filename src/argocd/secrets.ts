/**
 * ArgoCD app secrets — generate K8s Secrets with typed references.
 *
 * Standalone utility + wrapper for ArgoApp.createSecrets().
 *
 * @module argocd/secrets
 */

import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import type { IArgoSecretsConfig, IArgoAppSecrets } from "./interfaces";
import type { ICluster } from "../cluster";

/**
 * Create a K8s Secret with generated and/or explicit values.
 *
 * @param name - K8s Secret name
 * @param config.namespace - K8s namespace
 * @param config.cluster - Cluster for the provider
 * @param config.secrets - Map of key → { random: N } or { value: Output }
 */
export function createAppSecrets(
  name: string,
  config: {
    namespace: string;
    cluster: ICluster;
    secrets: IArgoSecretsConfig;
  }
): IArgoAppSecrets {
  const provider = config.cluster.provider;
  const secretData: Record<string, pulumi.Input<string>> = {};

  for (const [key, field] of Object.entries(config.secrets)) {
    if (field.random) {
      const pw = new random.RandomPassword(`${name}-${key}`, {
        length: field.random,
        special: false,
      });
      secretData[key] = pw.result;
    } else if (field.value !== undefined) {
      secretData[key] = field.value;
    }
  }

  new k8s.core.v1.Secret(
    `argocd-secret-${name}`,
    {
      metadata: {
        name,
        namespace: config.namespace,
        labels: { "app.kubernetes.io/managed-by": "nimbus" },
      },
      stringData: secretData,
    },
    { provider }
  );

  return {
    name,
    ref(key: string) {
      if (!(key in config.secrets)) {
        throw new Error(`Secret key "${key}" not found in "${name}". Available: ${Object.keys(config.secrets).join(", ")}`);
      }
      return { secretKeyRef: { name, key } };
    },
  };
}
