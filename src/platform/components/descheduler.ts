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
  const kind = raw.kind ?? "CronJob";
  const typedBudget = config.podDisruptionBudget;
  const rawBudget = raw.podDisruptionBudget as { enabled?: boolean } | undefined;
  const schedulingRequested = Boolean(
    config.scheduling?.replicas !== undefined || config.scheduling?.spread
  );
  if (kind !== "Deployment" && typedBudget?.enabled !== false && typedBudget !== undefined) {
    throw new Error("Descheduler podDisruptionBudget requires values.kind: Deployment");
  }
  if (kind !== "Deployment" && rawBudget?.enabled !== false && rawBudget !== undefined) {
    throw new Error("Descheduler raw values.podDisruptionBudget requires values.kind: Deployment");
  }
  if (kind !== "Deployment" && schedulingRequested) {
    throw new Error("Descheduler scheduling requires values.kind: Deployment");
  }
  if (typedBudget !== undefined && raw.podDisruptionBudget !== undefined) {
    throw new Error("podDisruptionBudget conflicts with Helm values.podDisruptionBudget");
  }
  const replicas = config.scheduling?.replicas ?? (raw.replicas as number | undefined) ?? 1;
  const budget =
    kind === "Deployment" && typedBudget !== undefined
      ? resolvePodDisruptionBudget(typedBudget, replicas)
      : undefined;
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
        ...(typedBudget !== undefined
          ? { podDisruptionBudget: budget ? { enabled: true, ...budget } : { enabled: false } }
          : {}),
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
  return release;
}
