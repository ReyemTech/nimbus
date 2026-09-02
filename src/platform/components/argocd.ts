/**
 * ArgoCD GitOps deployment.
 *
 * @module platform/components/argocd
 */

import * as k8s from "@pulumi/kubernetes";
import type { IPlatformComponentConfig } from "../interfaces";
import { ensureNamespace } from "../../utils/ensure-namespace";

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

export function deployArgocd(
  name: string,
  config: IPlatformComponentConfig,
  domain: string,
  provider: k8s.Provider,
  defaultVersion: string | undefined
): k8s.helm.v3.Release {
  ensureNamespace("argocd", provider);

  return new k8s.helm.v3.Release(
    `${name}-argocd`,
    {
      chart: "argo-cd",
      repositoryOpts: { repo: "https://argoproj.github.io/argo-helm" },
      version: config.version ?? defaultVersion,
      namespace: "argocd",
      createNamespace: false,
      values: mergeValues(
        {
          configs: {
            params: { "server.insecure": true },
          },
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
              annotations: {
                "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
              },
            },
            metrics: { enabled: true, serviceMonitor: { enabled: true } },
          },
          controller: {
            metrics: { enabled: true, serviceMonitor: { enabled: true } },
          },
          repoServer: {
            metrics: { enabled: true, serviceMonitor: { enabled: true } },
          },
          notifications: {
            enabled: true,
            cm: { create: false },
            secret: { create: false },
          },
        },
        config.values
      ),
    },
    { provider }
  );
}
