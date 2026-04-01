/**
 * ExternalSecret CRD creation — pulls secrets from Vault via ESO.
 *
 * Standalone utility + wrapper for ArgoApp.createExternalSecrets().
 *
 * @module argocd/external-secrets
 */

import * as k8s from "@pulumi/kubernetes";
import type { IExternalSecretsConfig, IArgoAppSecrets } from "./interfaces";
import type { ICluster } from "../cluster";

const DEFAULT_STORE = "vault-backend";
const DEFAULT_REFRESH = "1h";

/**
 * Create an ExternalSecret CRD that ESO syncs to a K8s Secret.
 *
 * @param name - K8s Secret name (ExternalSecret creates a Secret with this name)
 * @param config.namespace - Target namespace
 * @param config.cluster - Cluster for the provider
 * @param config.secrets - ExternalSecret config (data, dataFrom, store, refreshInterval)
 */
export function createExternalSecrets(
  name: string,
  config: {
    namespace: string;
    cluster: ICluster;
    secrets: IExternalSecretsConfig;
  }
): IArgoAppSecrets {
  const provider = config.cluster.provider;
  const store = config.secrets.store ?? DEFAULT_STORE;
  const refreshInterval = config.secrets.refreshInterval ?? DEFAULT_REFRESH;

  if (!config.secrets.data && !config.secrets.dataFrom) {
    throw new Error(`ExternalSecret "${name}" must have at least one of 'data' or 'dataFrom'`);
  }

  // Build spec.data — individual key mappings
  const data = config.secrets.data
    ? Object.entries(config.secrets.data).map(([secretKey, ref]) => ({
        secretKey,
        remoteRef: {
          key: ref.key,
          ...(ref.property ? { property: ref.property } : {}),
        },
      }))
    : undefined;

  // Build spec.dataFrom — bulk pull
  const dataFrom = config.secrets.dataFrom
    ? config.secrets.dataFrom.map((ref) => ({
        extract: { key: ref.key },
      }))
    : undefined;

  const spec: Record<string, unknown> = {
    refreshInterval,
    secretStoreRef: {
      name: store,
      kind: "ClusterSecretStore",
    },
    target: {
      name,
      creationPolicy: "Owner",
    },
  };

  if (data) spec["data"] = data;
  if (dataFrom) spec["dataFrom"] = dataFrom;

  new k8s.apiextensions.CustomResource(
    `eso-${name}`,
    {
      apiVersion: "external-secrets.io/v1",
      kind: "ExternalSecret",
      metadata: {
        name,
        namespace: config.namespace,
        labels: { "app.kubernetes.io/managed-by": "nimbus" },
      },
      spec,
    },
    { provider }
  );

  // Collect all known keys for ref() validation
  const knownKeys = new Set<string>();
  if (config.secrets.data) {
    for (const key of Object.keys(config.secrets.data)) {
      knownKeys.add(key);
    }
  }

  return {
    name,
    ref(key: string) {
      // For dataFrom, any key is valid (we can't know them at build time)
      if (!config.secrets.dataFrom && knownKeys.size > 0 && !knownKeys.has(key)) {
        throw new Error(
          `Secret key "${key}" not found in "${name}". Available: ${[...knownKeys].join(", ")}`
        );
      }
      return { secretKeyRef: { name, key } };
    },
  };
}
