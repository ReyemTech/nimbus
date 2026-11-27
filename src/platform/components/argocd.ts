/**
 * ArgoCD GitOps deployment.
 *
 * @module platform/components/argocd
 */

import * as k8s from "@pulumi/kubernetes";
import type { IPlatformComponentConfig } from "../interfaces";
import { buildPodDisruptionBudgetSpec, resolvePodDisruptionBudget } from "../../availability";
import { ensureNamespace } from "../../utils/ensure-namespace";
import { chartPodPlacement } from "./scheduling";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeValues(
  base: Record<string, unknown>,
  overrides: Readonly<Record<string, unknown>> | undefined
): Record<string, unknown> {
  if (!overrides) return base;

  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    const existing = merged[key];
    merged[key] = isRecord(existing) && isRecord(value) ? mergeValues(existing, value) : value;
  }
  return merged;
}

function addAvailability(
  release: k8s.helm.v3.Release,
  name: string,
  namespace: string,
  provider: k8s.Provider,
  config: IPlatformComponentConfig,
  replicas: number,
  selectors: ReadonlyArray<Record<string, string>>
): void {
  const budget = config.podDisruptionBudget ?? {};
  const replicaCount = replicas;
  for (const [index, selector] of selectors.entries()) {
    const spec = buildPodDisruptionBudgetSpec(budget, selector, replicaCount);
    if (spec)
      new k8s.policy.v1.PodDisruptionBudget(
        `${name}-pdb${selectors.length > 1 ? `-${index}` : ""}`,
        {
          metadata: { name: `${name}${selectors.length > 1 ? `-${index}` : ""}`, namespace },
          spec: spec.spec,
        },
        { provider, dependsOn: [release] }
      );
  }
}

function desiredReplicas(
  typed: number | undefined,
  raw: unknown,
  fallback: number,
  path: string
): number {
  const rawCount =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw)
        ? Number(raw)
        : undefined;
  if (typed !== undefined && rawCount !== undefined && typed !== rawCount) {
    throw new Error(`scheduling.replicas conflicts with Helm values.${path}`);
  }
  return typed ?? rawCount ?? fallback;
}

export function deployArgocd(
  name: string,
  config: IPlatformComponentConfig,
  domain: string,
  provider: k8s.Provider,
  defaultVersion: string | undefined
): k8s.helm.v3.Release {
  ensureNamespace("argocd", provider);

  const instance = `${name}-argocd`;
  const workloads = [
    ["controller", "argocd-application-controller"],
    ["server", "argocd-server"],
    ["repoServer", "argocd-repo-server"],
    ["applicationSet", "argocd-applicationset-controller"],
    ["notifications", "argocd-notifications-controller"],
  ] as const;
  const values = mergeValues(
    {
      configs: { params: { "server.insecure": true } },
      server: {
        ingress: {
          enabled: true,
          ingressClassName: "traefik",
          hostname: `argocd.${domain}`,
          tls: true,
          extraTls: [
            {
              secretName: `${domain.replace(/\./g, "-")}-wildcard-tls`,
              hosts: [`argocd.${domain}`],
            },
          ],
          annotations: { "traefik.ingress.kubernetes.io/router.entrypoints": "websecure" },
        },
        metrics: { enabled: true, serviceMonitor: { enabled: true } },
      },
      controller: { metrics: { enabled: true, serviceMonitor: { enabled: true } } },
      repoServer: { metrics: { enabled: true, serviceMonitor: { enabled: true } } },
      notifications: { enabled: true, cm: { create: false }, secret: { create: false } },
    },
    config.values
  );
  for (const [chartKey] of workloads) {
    const existing = values[chartKey] as Record<string, unknown> | undefined;
    const replicas =
      chartKey === "notifications"
        ? 1
        : desiredReplicas(
            config.scheduling?.replicas,
            existing?.replicas,
            1,
            `${chartKey}.replicas`
          );
    const workloadName = workloads.find(([key]) => key === chartKey)?.[1];
    if (!workloadName) throw new Error(`Unknown Argo CD workload key: ${chartKey}`);
    const selector = {
      "app.kubernetes.io/name": workloadName,
      "app.kubernetes.io/instance": instance,
    };
    values[chartKey] = {
      ...existing,
      ...(chartKey !== "notifications" && config.scheduling?.replicas !== undefined
        ? { replicas: config.scheduling.replicas }
        : {}),
      ...chartPodPlacement(config.scheduling?.spread, selector, existing ?? {}, "Argo CD"),
      ...(["controller", "server", "repoServer"].includes(chartKey)
        ? {
            pdb: nativeBudget(
              config,
              replicas,
              existing?.pdb as Record<string, unknown> | undefined
            ),
          }
        : {}),
    };
  }
  chartPodPlacement(
    config.scheduling?.spread,
    {},
    (values.global as Record<string, unknown> | undefined) ?? {},
    "Argo CD global"
  );
  const release = new k8s.helm.v3.Release(
    `${name}-argocd`,
    {
      chart: "argo-cd",
      repositoryOpts: { repo: "https://argoproj.github.io/argo-helm" },
      version: config.version ?? defaultVersion,
      namespace: "argocd",
      createNamespace: false,
      values,
    },
    { provider }
  );
  const applicationSetSelector = {
    "app.kubernetes.io/name": "argocd-applicationset-controller",
    "app.kubernetes.io/instance": instance,
  };
  const notificationSelector = {
    "app.kubernetes.io/name": "argocd-notifications-controller",
    "app.kubernetes.io/instance": instance,
  };
  const applicationSetValues = values.applicationSet as Record<string, unknown>;
  const applicationSetReplicas = desiredReplicas(
    config.scheduling?.replicas,
    applicationSetValues.replicas,
    1,
    "applicationSet.replicas"
  );
  addAvailability(release, instance, "argocd", provider, config, applicationSetReplicas, [
    applicationSetSelector,
  ]);
  // The chart hard-codes one notifications replica and has no replica value.
  addAvailability(release, `${instance}-notifications`, "argocd", provider, config, 1, [
    notificationSelector,
  ]);
  return release;
}

function nativeBudget(
  config: IPlatformComponentConfig,
  replicas: number,
  rawBudget?: unknown
): Record<string, unknown> {
  if (rawBudget !== undefined) {
    if (config.podDisruptionBudget !== undefined) {
      throw new Error("podDisruptionBudget conflicts with Helm chart PDB values");
    }
    return rawBudget as Record<string, unknown>;
  }
  const budget = resolvePodDisruptionBudget(config.podDisruptionBudget ?? {}, replicas);
  return budget ? { enabled: true, ...budget } : { enabled: false };
}
