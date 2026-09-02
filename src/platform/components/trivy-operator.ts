/**
 * Trivy Operator deployment for continuous cluster workload scanning.
 *
 * @module platform/components/trivy-operator
 */

import * as k8s from "@pulumi/kubernetes";
import type { IPlatformComponentConfig } from "../interfaces";

export function deployTrivyOperator(
  name: string,
  config: IPlatformComponentConfig,
  provider: k8s.Provider,
  defaultVersion: string | undefined
): k8s.helm.v3.Release {
  return new k8s.helm.v3.Release(
    `${name}-trivy-operator`,
    {
      chart: "trivy-operator",
      repositoryOpts: { repo: "https://aquasecurity.github.io/helm-charts" },
      version: config.version ?? defaultVersion,
      namespace: "trivy-system",
      createNamespace: true,
      values: {
        operator: {
          scanJobTimeout: "10m",
          scanJobsConcurrentLimit: 5,
        },
        trivy: {
          // Report unfixed CVEs too, so exposure is visible before a patch exists.
          ignoreUnfixed: false,
        },
        ...config.values,
      },
    },
    { provider }
  );
}
