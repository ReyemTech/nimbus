/**
 * External Secrets Operator deployment.
 *
 * @module platform/components/external-secrets
 */

import * as k8s from "@pulumi/kubernetes";
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
      throw new Error("podDisruptionBudget conflicts with Helm chart PDB values");
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

export function deployExternalSecrets(
  name: string,
  config: IPlatformComponentConfig,
  provider: k8s.Provider,
  defaultVersion: string | undefined
): k8s.helm.v3.Release {
  ensureNamespace("external-secrets", provider);

  const instance = `${name}-external-secrets`;
  const selector = {
    "app.kubernetes.io/name": "external-secrets",
    "app.kubernetes.io/instance": instance,
  };
  const rawValues = config.values ?? {};
  const rawWebhook = rawValues.webhook as Record<string, unknown> | undefined;
  const rawCertController = rawValues.certController as Record<string, unknown> | undefined;
  const replicas = desiredReplicas(
    config.scheduling?.replicas,
    rawValues.replicaCount,
    1,
    "replicaCount"
  );
  const webhookReplicas = desiredReplicas(
    config.scheduling?.replicas,
    rawWebhook?.replicaCount,
    1,
    "webhook.replicaCount"
  );
  const certControllerReplicas = desiredReplicas(
    config.scheduling?.replicas,
    rawCertController?.replicaCount,
    1,
    "certController.replicaCount"
  );
  const values = {
    serviceAccount: { name: "external-secrets" },
    crds: { createClusterExternalSecret: true, createClusterSecretStore: true },
    ...rawValues,
    ...topologySpread(config, selector),
    ...(config.scheduling?.replicas !== undefined
      ? { replicaCount: config.scheduling.replicas }
      : {}),
    podDisruptionBudget: nativeBudget(config, replicas, rawValues.podDisruptionBudget),
    webhook: {
      ...(rawWebhook ?? {}),
      failurePolicy:
        ((rawValues.webhook as Record<string, unknown> | undefined)?.failurePolicy as
          | string
          | undefined) ?? "Ignore",
      timeoutSeconds:
        ((rawValues.webhook as Record<string, unknown> | undefined)?.timeoutSeconds as
          | number
          | undefined) ?? 15,
      ...(config.scheduling?.replicas !== undefined
        ? { replicaCount: config.scheduling.replicas }
        : {}),
      podDisruptionBudget: nativeBudget(config, webhookReplicas, rawWebhook?.podDisruptionBudget),
      ...topologySpread(config, {
        "app.kubernetes.io/name": "external-secrets-webhook",
        "app.kubernetes.io/instance": instance,
      }),
    },
    certController: {
      ...(rawCertController ?? {}),
      ...(config.scheduling?.replicas !== undefined
        ? { replicaCount: config.scheduling.replicas }
        : {}),
      podDisruptionBudget: nativeBudget(
        config,
        certControllerReplicas,
        rawCertController?.podDisruptionBudget
      ),
      ...topologySpread(config, {
        "app.kubernetes.io/name": "external-secrets-cert-controller",
        "app.kubernetes.io/instance": instance,
      }),
    },
  };
  const release = new k8s.helm.v3.Release(
    `${name}-external-secrets`,
    {
      chart: "external-secrets",
      repositoryOpts: { repo: "https://charts.external-secrets.io" },
      version: config.version ?? defaultVersion,
      namespace: "external-secrets",
      createNamespace: false,
      values,
    },
    { provider }
  );
  return release;
}
