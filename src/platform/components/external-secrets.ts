/**
 * External Secrets Operator deployment.
 *
 * @module platform/components/external-secrets
 */

import * as k8s from "@pulumi/kubernetes";
import type { IPlatformComponentConfig } from "../interfaces";

export function deployExternalSecrets(
  name: string,
  config: IPlatformComponentConfig,
  provider: k8s.Provider,
  defaultVersion: string | undefined
): k8s.helm.v3.Release {
  return new k8s.helm.v3.Release(
    `${name}-external-secrets`,
    {
      chart: "external-secrets",
      repositoryOpts: { repo: "https://charts.external-secrets.io" },
      version: config.version ?? defaultVersion,
      namespace: "external-secrets",
      createNamespace: true,
      values: {
        crds: {
          createClusterExternalSecret: true,
          createClusterSecretStore: true,
        },
        ...config.values,
      },
    },
    { provider }
  );
}
