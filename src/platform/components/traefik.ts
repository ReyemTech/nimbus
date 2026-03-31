/**
 * Traefik ingress controller deployment.
 *
 * @module platform/components/traefik
 */

import * as k8s from "@pulumi/kubernetes";
import type { IPlatformComponentConfig } from "../interfaces";

export function deployTraefik(
  name: string,
  config: IPlatformComponentConfig | undefined,
  provider: k8s.Provider,
  defaultVersion: string | undefined,
  robotsBlock?: boolean
): k8s.helm.v3.Release {
  return new k8s.helm.v3.Release(
    `${name}-traefik`,
    {
      chart: "traefik",
      repositoryOpts: { repo: "https://traefik.github.io/charts" },
      version: config?.version ?? defaultVersion,
      namespace: "traefik",
      createNamespace: true,
      values: {
        ingressClass: { enabled: true, isDefaultClass: true, name: "traefik" },
        ingressRoute: {
          dashboard: { enabled: false },
        },
        ports: {
          metrics: { expose: { default: true } },
          web: {
            http: {
              redirections: {
                entryPoint: { to: "websecure", scheme: "https" },
              },
            },
          },
          ...(robotsBlock && {
            websecure: {
              http: { middlewares: ["traefik-robots-block@kubernetescrd"] },
            },
          }),
        },
        ...config?.values,
      },
    },
    { provider }
  );
}
