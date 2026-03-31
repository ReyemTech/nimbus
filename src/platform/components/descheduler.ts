/**
 * Descheduler deployment for pod rebalancing on spot instances.
 *
 * @module platform/components/descheduler
 */

import * as k8s from "@pulumi/kubernetes";
import type { IDeschedulerConfig } from "../interfaces";

export function deployDescheduler(
  name: string,
  config: IDeschedulerConfig,
  provider: k8s.Provider,
  defaultVersion: string | undefined
): k8s.helm.v3.Release {
  const strategies = config.strategies ?? [
    "RemoveDuplicates",
    "LowNodeUtilization",
    "RemovePodsViolatingNodeAffinity",
  ];

  const strategyValues: Record<string, { enabled: boolean }> = {};
  for (const strategy of strategies) {
    strategyValues[strategy] = { enabled: true };
  }

  return new k8s.helm.v3.Release(
    `${name}-descheduler`,
    {
      chart: "descheduler",
      repositoryOpts: {
        repo: "https://kubernetes-sigs.github.io/descheduler",
      },
      version: config.version ?? defaultVersion,
      namespace: "kube-system",
      createNamespace: false,
      values: {
        deschedulerPolicy: { strategies: strategyValues },
        ...config.values,
      },
    },
    { provider }
  );
}
