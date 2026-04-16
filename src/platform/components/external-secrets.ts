/**
 * External Secrets Operator deployment.
 *
 * @module platform/components/external-secrets
 */

import * as k8s from "@pulumi/kubernetes";
import type { IPlatformComponentConfig } from "../interfaces";
import { ensureNamespace } from "../../utils/ensure-namespace";

export function deployExternalSecrets(
  name: string,
  config: IPlatformComponentConfig,
  provider: k8s.Provider,
  defaultVersion: string | undefined
): k8s.helm.v3.Release {
  ensureNamespace("external-secrets", provider);

  return new k8s.helm.v3.Release(
    `${name}-external-secrets`,
    {
      chart: "external-secrets",
      repositoryOpts: { repo: "https://charts.external-secrets.io" },
      version: config.version ?? defaultVersion,
      namespace: "external-secrets",
      createNamespace: false,
      values: {
        serviceAccount: {
          name: "external-secrets",
        },
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
