/**
 * Trivy Operator deployment for continuous cluster workload scanning.
 *
 * @module platform/components/trivy-operator
 */

import * as k8s from "@pulumi/kubernetes";
import type { IPlatformComponentConfig } from "../interfaces";
import { resolvePodDisruptionBudget } from "../../availability";
import { chartPodPlacement } from "./scheduling";

export function deployTrivyOperator(
  name: string,
  config: IPlatformComponentConfig,
  provider: k8s.Provider,
  defaultVersion: string | undefined
): k8s.helm.v3.Release {
  const instance = `${name}-trivy-operator`;
  const raw = config.values ?? {};
  const rawOperator = (raw.operator ?? {}) as Record<string, unknown>;
  const rawTrivy = (raw.trivy ?? {}) as Record<string, unknown>;
  const replicas = config.scheduling?.replicas ?? (rawOperator.replicas as number | undefined) ?? 1;
  const release = new k8s.helm.v3.Release(
    instance,
    {
      chart: "trivy-operator",
      repositoryOpts: { repo: "https://aquasecurity.github.io/helm-charts" },
      version: config.version ?? defaultVersion,
      namespace: "trivy-system",
      createNamespace: true,
      values: {
        ...raw,
        operator: {
          scanJobTimeout: "10m",
          scanJobsConcurrentLimit: 5,
          ...rawOperator,
          ...chartPodPlacement(
            config.scheduling?.spread,
            { "app.kubernetes.io/name": "trivy-operator", "app.kubernetes.io/instance": instance },
            rawOperator,
            "Trivy Operator"
          ),
          ...(config.scheduling?.replicas !== undefined
            ? { replicas: config.scheduling.replicas }
            : {}),
        },
        trivy: {
          // Report unfixed CVEs too, so exposure is visible before a patch exists.
          ignoreUnfixed: false,
          ...rawTrivy,
        },
      },
    },
    { provider }
  );
  const budget = resolvePodDisruptionBudget(config.podDisruptionBudget ?? {}, replicas);
  if (budget)
    new k8s.policy.v1.PodDisruptionBudget(
      `${instance}-pdb`,
      {
        metadata: { name: instance, namespace: "trivy-system" },
        spec: {
          ...budget,
          selector: {
            matchLabels: {
              "app.kubernetes.io/name": "trivy-operator",
              "app.kubernetes.io/instance": instance,
            },
          },
        },
      },
      { provider, dependsOn: [release] }
    );
  return release;
}
