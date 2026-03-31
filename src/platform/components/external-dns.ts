/**
 * External DNS deployment.
 *
 * @module platform/components/external-dns
 */

import * as k8s from "@pulumi/kubernetes";
import type { IExternalDnsConfig } from "../interfaces";
import { assertNever } from "../../types";

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

  return new k8s.helm.v3.Release(
    `${name}-external-dns`,
    {
      chart: "external-dns",
      repositoryOpts: {
        repo: "https://kubernetes-sigs.github.io/external-dns",
      },
      version: config.version ?? defaultVersion,
      namespace: "external-dns",
      createNamespace: true,
      values,
    },
    { provider }
  );
}
