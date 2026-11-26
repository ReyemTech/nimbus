/**
 * External DNS deployment.
 *
 * @module platform/components/external-dns
 */

import * as k8s from "@pulumi/kubernetes";
import type { IExternalDnsConfig, IPlatformComponentConfig } from "../interfaces";
import { buildPodDisruptionBudgetSpec } from "../../availability";
import { assertNever } from "../../types";
import { ensureNamespace } from "../../utils/ensure-namespace";

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
  const replicaCount = config.scheduling?.replicas ?? replicas;
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

export function deployExternalDns(
  name: string,
  config: IExternalDnsConfig,
  provider: k8s.Provider,
  defaultVersion: string | undefined,
  envOverrides?: ReadonlyArray<Record<string, unknown>>
): k8s.helm.v3.Release {
  const providerValues: Record<string, unknown> = {};

  switch (config.dnsProvider) {
    case "route53":
      providerValues["provider"] = { name: "aws" };
      break;
    case "azure-dns":
      providerValues["provider"] = { name: "azure" };
      break;
    case "cloud-dns":
      providerValues["provider"] = { name: "google" };
      break;
    case "cloudflare":
      providerValues["provider"] = { name: "cloudflare" };
      break;
    default:
      assertNever(config.dnsProvider);
  }

  const values: Record<string, unknown> = {
    ...providerValues,
    domainFilters: config.domainFilters ?? [],
    policy: "sync",
    sources: ["ingress", "service", "traefik-proxy"],
    ...config.values,
  };

  if (envOverrides) {
    values["env"] = envOverrides;
  }
  const instance = `${name}-external-dns`;
  const selector = {
    "app.kubernetes.io/name": "external-dns",
    "app.kubernetes.io/instance": instance,
  };
  const replicas = desiredReplicas(
    config.scheduling?.replicas,
    config.values?.replicaCount,
    1,
    "replicaCount"
  );
  Object.assign(values, {
    ...config.values,
    ...topologySpread(config, selector),
    ...(config.scheduling?.replicas !== undefined
      ? { replicaCount: config.scheduling.replicas }
      : {}),
  });

  ensureNamespace("external-dns", provider);

  const release = new k8s.helm.v3.Release(
    `${name}-external-dns`,
    {
      chart: "external-dns",
      repositoryOpts: {
        repo: "https://kubernetes-sigs.github.io/external-dns",
      },
      version: config.version ?? defaultVersion,
      namespace: "external-dns",
      createNamespace: false,
      values,
    },
    { provider }
  );
  addAvailability(release, instance, "external-dns", provider, config, replicas, [selector]);
  return release;
}
