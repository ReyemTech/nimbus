/**
 * ArgoCD GitOps deployment.
 *
 * @module platform/components/argocd
 */

import * as k8s from "@pulumi/kubernetes";
import type { IPlatformComponentConfig } from "../interfaces";
import { ensureNamespace } from "../../utils/ensure-namespace";

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
      values: {
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
        ...config.values,
      },
    },
    { provider }
  );
}
