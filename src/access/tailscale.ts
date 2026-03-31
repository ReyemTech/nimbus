/**
 * Tailscale access gateway provider.
 *
 * Deploys the Tailscale K8s Operator + Connector CRD for subnet routing.
 * Optional split DNS via shared CoreDNS.
 *
 * @module access/tailscale
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { ITailscaleGatewayConfig, IAccessGateway } from "./interfaces";
import { deployAccessDns } from "./dns";
import { ensureNamespace } from "../utils/ensure-namespace";

const NAMESPACE = "access";

/**
 * Deploy Tailscale access gateway.
 */
export function deployTailscale(
  name: string,
  config: ITailscaleGatewayConfig
): IAccessGateway {
  const provider = config.cluster.provider;
  const prefix = config.hostnamePrefix ?? name;
  const nsResource = ensureNamespace(NAMESPACE, provider);

  // Auth key secret — Tailscale Operator reads from this
  const authSecret = new k8s.core.v1.Secret(
    `${name}-tailscale-auth`,
    {
      metadata: { name: "tailscale-auth", namespace: NAMESPACE },
      stringData: {
        TS_AUTHKEY: config.tailscale.authKey,
      },
    },
    { provider, dependsOn: [nsResource] }
  );

  // Tailscale Operator Helm chart
  const helmRelease = new k8s.helm.v3.Release(
    `${name}-tailscale-operator`,
    {
      chart: "tailscale-operator",
      repositoryOpts: { repo: "https://pkgs.tailscale.com/helmcharts" },
      version: config.tailscale.version,
      namespace: NAMESPACE,
      createNamespace: false,
      values: {
        operatorConfig: {
          defaultTags: ["tag:k8s"],
        },
        ...config.tailscale.values,
      },
    },
    { provider, dependsOn: [nsResource, authSecret] }
  );

  // Connector CRD — advertise subnet routes
  new k8s.apiextensions.CustomResource(
    `${name}-tailscale-connector`,
    {
      apiVersion: "tailscale.com/v1alpha1",
      kind: "Connector",
      metadata: { name: `${name}-subnet-router`, namespace: NAMESPACE },
      spec: {
        hostname: prefix,
        subnetRouter: {
          advertiseRoutes: config.tailscale.routes,
        },
      },
    },
    { provider, dependsOn: [helmRelease] }
  );

  // Split DNS
  if (config.dns?.enabled) {
    const dns = deployAccessDns(name, prefix, config.dns, NAMESPACE, provider, [nsResource]);
    dns.clusterIp.apply((ip) =>
      pulumi.log.info(
        `Access DNS deployed. Configure Tailscale split DNS:\n` +
          `  Nameserver: ${ip}\n` +
          `  Domain: ${dns.zone}`,
        helmRelease
      )
    );
  }

  return {
    name,
    provider: "tailscale",
    namespace: NAMESPACE,
    helmRelease,
  };
}
