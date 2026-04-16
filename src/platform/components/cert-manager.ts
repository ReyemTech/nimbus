/**
 * cert-manager TLS certificate management deployment.
 *
 * @module platform/components/cert-manager
 */

import * as k8s from "@pulumi/kubernetes";
import type { IPlatformComponentConfig } from "../interfaces";
import { ensureNamespace } from "../../utils/ensure-namespace";

export function deployCertManager(
  name: string,
  config: IPlatformComponentConfig | undefined,
  provider: k8s.Provider,
  defaultVersion: string | undefined
): k8s.helm.v3.Release {
  ensureNamespace("cert-manager", provider);

  return new k8s.helm.v3.Release(
    `${name}-cert-manager`,
    {
      chart: "cert-manager",
      repositoryOpts: { repo: "https://charts.jetstack.io" },
      version: config?.version ?? defaultVersion,
      namespace: "cert-manager",
      createNamespace: false,
      values: {
        crds: { enabled: true },
        ...config?.values,
      },
    },
    { provider }
  );
}
