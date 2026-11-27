/**
 * OAuth2 Proxy deployment for dashboard protection.
 *
 * @module platform/components/oauth2-proxy
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { createHash } from "crypto";
import type { IPlatformComponentConfig } from "../interfaces";
import { ensureNamespace } from "../../utils/ensure-namespace";
import { resolvePodDisruptionBudget } from "../../availability";
import { chartPodPlacement } from "./scheduling";

export function deployOAuth2Proxy(
  name: string,
  config: IPlatformComponentConfig & {
    readonly provider: "google" | "github" | "azure";
    readonly clientId: pulumi.Input<string>;
    readonly clientSecret: pulumi.Input<string>;
  },
  domain: string,
  provider: k8s.Provider,
  defaultVersion: string | undefined
): k8s.helm.v3.Release {
  // Generate a deterministic cookie secret from the stack name via SHA-256.
  // In production, override via config.values.config.cookieSecret.
  const cookieSecret = pulumi.output(name).apply((n) => {
    return createHash("sha256").update(`${n}-oauth2-proxy-cookie`).digest("base64").slice(0, 32);
  });

  ensureNamespace("traefik", provider);
  const instance = `${name}-oauth2-proxy`;
  const raw = config.values ?? {};
  const replicas = config.scheduling?.replicas ?? (raw.replicaCount as number | undefined) ?? 1;

  const release = new k8s.helm.v3.Release(
    instance,
    {
      chart: "oauth2-proxy",
      repositoryOpts: {
        repo: "https://oauth2-proxy.github.io/manifests",
      },
      version: config.version ?? defaultVersion,
      namespace: "traefik",
      createNamespace: false,
      values: {
        config: {
          clientID: config.clientId,
          clientSecret: config.clientSecret,
          cookieSecret,
        },
        extraArgs: {
          provider: config.provider,
          "email-domain": "*",
          "cookie-secure": "true",
          upstream: "static://202",
          "reverse-proxy": "true",
          "set-xauthrequest": "true",
          "cookie-domain": `.${domain}`,
          "whitelist-domain": `.${domain}`,
        },
        service: { portNumber: 4180 },
        ...raw,
        ...chartPodPlacement(
          config.scheduling?.spread,
          { "app.kubernetes.io/name": "oauth2-proxy", "app.kubernetes.io/instance": instance },
          raw,
          "OAuth2 Proxy"
        ),
        ...(config.scheduling?.replicas !== undefined
          ? { replicaCount: config.scheduling.replicas }
          : {}),
      },
    },
    { provider }
  );
  const budget = resolvePodDisruptionBudget(config.podDisruptionBudget ?? {}, replicas);
  if (budget)
    new k8s.policy.v1.PodDisruptionBudget(
      `${instance}-pdb`,
      {
        metadata: { name: instance, namespace: "traefik" },
        spec: {
          ...budget,
          selector: {
            matchLabels: {
              "app.kubernetes.io/name": "oauth2-proxy",
              "app.kubernetes.io/instance": instance,
            },
          },
        },
      },
      { provider, dependsOn: [release] }
    );
  return release;
}
