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

  return new k8s.helm.v3.Release(
    `${name}-oauth2-proxy`,
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
        ...config.values,
      },
    },
    { provider }
  );
}
