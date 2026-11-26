/**
 * cert-manager TLS certificate management deployment.
 *
 * @module platform/components/cert-manager
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

export function deployCertManager(
  name: string,
  config: IPlatformComponentConfig | undefined,
  provider: k8s.Provider,
  defaultVersion: string | undefined,
  podIdentityAssociation?: pulumi.Resource,
  podIdentityAssociationId?: pulumi.Input<string>,
  dns01RecursiveNameservers?: ReadonlyArray<string>
): k8s.helm.v3.Release {
  ensureNamespace("cert-manager", provider);
  const serviceAccountValues =
    (config?.values?.serviceAccount as Record<string, unknown> | undefined) ?? {};
  const podAnnotations =
    (config?.values?.podAnnotations as Record<string, unknown> | undefined) ?? {};
  const configuredExtraArgs = Array.isArray(config?.values?.extraArgs)
    ? config.values.extraArgs.filter((arg): arg is string => typeof arg === "string")
    : [];
  const extraArgs = dns01RecursiveNameservers
    ? [
        ...configuredExtraArgs.filter(
          (arg) =>
            !arg.startsWith("--dns01-recursive-nameservers=") &&
            arg !== "--dns01-recursive-nameservers-only"
        ),
        "--dns01-recursive-nameservers-only",
        `--dns01-recursive-nameservers=${dns01RecursiveNameservers.join(",")}`,
      ]
    : undefined;

  const instance = `${name}-cert-manager`;
  const selector = {
    "app.kubernetes.io/name": "cert-manager",
    "app.kubernetes.io/instance": instance,
  };
  const rawValues = config?.values ?? {};
  const rawWebhook = rawValues.webhook as Record<string, unknown> | undefined;
  const rawCainjector = rawValues.cainjector as Record<string, unknown> | undefined;
  const replicaCount = desiredReplicas(
    config?.scheduling?.replicas,
    rawValues.replicaCount,
    1,
    "replicaCount"
  );
  const webhookReplicas = desiredReplicas(
    config?.scheduling?.replicas,
    rawWebhook?.replicaCount,
    1,
    "webhook.replicaCount"
  );
  const cainjectorReplicas = desiredReplicas(
    config?.scheduling?.replicas,
    rawCainjector?.replicaCount,
    1,
    "cainjector.replicaCount"
  );
  const values = {
    crds: { enabled: true },
    ...rawValues,
    ...(extraArgs ? { extraArgs } : {}),
    ...(config?.scheduling?.replicas !== undefined
      ? { replicaCount: config.scheduling.replicas }
      : {}),
    podDisruptionBudget: nativeBudget(
      config ?? {},
      replicaCount,
      config?.values?.podDisruptionBudget
    ),
    ...topologySpread(config ?? {}, selector),
    webhook: {
      ...(rawWebhook ?? {}),
      ...(config?.scheduling?.replicas !== undefined
        ? { replicaCount: config.scheduling.replicas }
        : {}),
      podDisruptionBudget: nativeBudget(
        config ?? {},
        webhookReplicas,
        rawWebhook?.podDisruptionBudget
      ),
      ...topologySpread(config ?? {}, {
        "app.kubernetes.io/name": "webhook",
        "app.kubernetes.io/instance": instance,
      }),
    },
    cainjector: {
      ...(rawCainjector ?? {}),
      ...(config?.scheduling?.replicas !== undefined
        ? { replicaCount: config.scheduling.replicas }
        : {}),
      podDisruptionBudget: nativeBudget(
        config ?? {},
        cainjectorReplicas,
        rawCainjector?.podDisruptionBudget
      ),
      ...topologySpread(config ?? {}, {
        "app.kubernetes.io/name": "cainjector",
        "app.kubernetes.io/instance": instance,
      }),
    },
    ...(podIdentityAssociation && {
      serviceAccount: { name: certManagerServiceAccountName(config), ...serviceAccountValues },
    }),
    ...(podIdentityAssociationId && {
      podAnnotations: {
        ...podAnnotations,
        "nimbus.dev/route53-pod-identity": podIdentityAssociationId,
      },
    }),
  };
  const release = new k8s.helm.v3.Release(
    `${name}-cert-manager`,
    {
      chart: "cert-manager",
      repositoryOpts: { repo: "https://charts.jetstack.io" },
      version: config?.version ?? defaultVersion,
      namespace: "cert-manager",
      createNamespace: false,
      values,
    },
    { provider, dependsOn: podIdentityAssociation ? [podIdentityAssociation] : undefined }
  );
  return release;
}

/** Return the service account name shared by the Helm chart and EKS Pod Identity. */
export function certManagerServiceAccountName(
  config: IPlatformComponentConfig | undefined
): pulumi.Input<string> {
  const serviceAccount = config?.values?.serviceAccount as
    | { readonly name?: pulumi.Input<string> }
    | undefined;
  return serviceAccount?.name ?? "cert-manager";
}
