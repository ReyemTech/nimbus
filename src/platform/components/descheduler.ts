/**
 * Descheduler deployment for pod rebalancing on spot instances.
 *
 * @module platform/components/descheduler
 */

import * as k8s from "@pulumi/kubernetes";
import type { IDeschedulerConfig } from "../interfaces";
import { resolvePodDisruptionBudget } from "../../availability";
import { chartPodPlacement } from "./scheduling";

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

  const instance = `${name}-descheduler`;
  const raw = config.values ?? {};
  const replicas = config.scheduling?.replicas ?? (raw.replicas as number | undefined) ?? 1;
  const release = new k8s.helm.v3.Release(
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
        ...raw,
        ...chartPodPlacement(
          config.scheduling?.spread,
          { "app.kubernetes.io/name": "descheduler", "app.kubernetes.io/instance": instance },
          raw,
          "Descheduler"
        ),
        ...(config.scheduling?.replicas !== undefined
          ? { replicas: config.scheduling.replicas }
          : {}),
      },
    },
    { provider }
  );
  const budget = resolvePodDisruptionBudget(config.podDisruptionBudget ?? {}, replicas);
  if (budget)
    new k8s.policy.v1.PodDisruptionBudget(
      `${instance}-pdb`,
      {
        metadata: { name: instance, namespace: "kube-system" },
        spec: {
          ...budget,
          selector: {
            matchLabels: {
              "app.kubernetes.io/name": "descheduler",
              "app.kubernetes.io/instance": instance,
            },
          },
        },
      },
      { provider, dependsOn: [release] }
    );
  return release;
}
