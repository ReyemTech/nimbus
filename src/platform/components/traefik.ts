/**
 * Traefik ingress controller deployment.
 *
 * @module platform/components/traefik
 */

import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import type { IPlatformComponentConfig } from "../interfaces";
import { resolvePodDisruptionBudget } from "../../availability";
import { ensureNamespace } from "../../utils/ensure-namespace";

function nativeBudget(
  config: IPlatformComponentConfig,
  replicas: number,
  rawBudget?: unknown
): Record<string, unknown> {
  if (rawBudget !== undefined) {
    if (config.podDisruptionBudget !== undefined) {
      throw new Error("podDisruptionBudget conflicts with Helm values.podDisruptionBudget");
    }
    return rawBudget as Record<string, unknown>;
  }
  const budget = resolvePodDisruptionBudget(config.podDisruptionBudget ?? {}, replicas);
  return budget ? { enabled: true, ...budget } : { enabled: false };
}

function topologySpread(
  config: IPlatformComponentConfig,
  selector: Record<string, string>
): Record<string, unknown> {
  const spread = config.scheduling?.spread;
  if (!spread) return {};
  return {
    topologySpreadConstraints: [
      {
        maxSkew: 1,
        topologyKey: spread.topologyKey ?? "kubernetes.io/hostname",
        whenUnsatisfiable: spread.mode === "required" ? "DoNotSchedule" : "ScheduleAnyway",
        labelSelector: { matchLabels: selector },
      },
    ],
  };
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

export function deployTraefik(
  name: string,
  config: IPlatformComponentConfig | undefined,
  provider: k8s.Provider,
  defaultVersion: string | undefined,
  robotsBlock?: boolean,
  dependsOn?: ReadonlyArray<pulumi.Resource>
): k8s.helm.v3.Release {
  ensureNamespace("traefik", provider);

  const instance = `${name}-traefik`;
  const selector = { "app.kubernetes.io/name": "traefik", "app.kubernetes.io/instance": instance };
  const rawDeployment = config?.values?.deployment as Record<string, unknown> | undefined;
  const replicas = desiredReplicas(
    config?.scheduling?.replicas,
    rawDeployment?.replicas,
    1,
    "deployment.replicas"
  );
  const values = {
    ingressClass: { enabled: true, isDefaultClass: true, name: "traefik" },
    ingressRoute: { dashboard: { enabled: false } },
    ports: {
      metrics: { expose: { default: true } },
      web: { http: { redirections: { entryPoint: { to: "websecure", scheme: "https" } } } },
      ...(robotsBlock && {
        websecure: { http: { middlewares: ["traefik-robots-block@kubernetescrd"] } },
      }),
    },
    ...config?.values,
    deployment: {
      ...(rawDeployment ?? {}),
      ...(config?.scheduling?.replicas !== undefined
        ? { replicas: config.scheduling.replicas }
        : {}),
    },
    ...topologySpread(config ?? {}, selector),
    podDisruptionBudget: nativeBudget(config ?? {}, replicas, config?.values?.podDisruptionBudget),
  };
  const release = new k8s.helm.v3.Release(
    `${name}-traefik`,
    {
      chart: "traefik",
      repositoryOpts: { repo: "https://traefik.github.io/charts" },
      version: config?.version ?? defaultVersion,
      namespace: "traefik",
      createNamespace: false,
      values,
    },
    { provider, dependsOn: [...(dependsOn ?? [])] }
  );
  return release;
}
