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
import { deployAccessProxy } from "./proxy";
import { TailscaleSplitDns } from "./tailscale-dns";
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
  const tags = config.tailscale.tags ?? ["tag:k8s"];
  const nsResource = ensureNamespace(NAMESPACE, provider);

  // Tailscale Operator Helm chart — uses OAuth client credentials
  const helmRelease = new k8s.helm.v3.Release(
    `${name}-tailscale-operator`,
    {
      chart: "tailscale-operator",
      repositoryOpts: { repo: "https://pkgs.tailscale.com/helmcharts" },
      version: config.tailscale.version,
      namespace: NAMESPACE,
      createNamespace: false,
      values: {
        oauth: {
          clientId: config.tailscale.oauthClientId,
          clientSecret: config.tailscale.oauthClientSecret,
        },
        ...(tags.length > 0 && {
          operatorConfig: {
            defaultTags: tags,
          },
        }),
        ...config.tailscale.values,
      },
    },
    { provider, dependsOn: [nsResource] }
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

  // Expose services via Tailscale — annotate original K8s Services (not aliases)
  if (config.tailscale.services) {
    for (const svc of config.tailscale.services) {
      const targetName = svc.originalName ?? svc.name;
      new k8s.core.v1.ServicePatch(
        `${name}-ts-expose-${svc.label}`,
        {
          metadata: {
            name: pulumi.output(targetName),
            namespace: svc.namespace,
            annotations: {
              "pulumi.com/patchForce": "true",
              "tailscale.com/expose": "true",
              "tailscale.com/hostname": `${prefix}-${svc.label}`,
            },
          },
        },
        { provider, dependsOn: [helmRelease] }
      );
    }
  }

  // Reverse proxy — port 80 access to all exposed services
  if (config.tailscale.services && config.tailscale.services.length > 0 && config.dns?.enabled) {
    const tld = config.dns.tld ?? "internal";
    const dnsSuffix = `${prefix}.${tld}`;
    deployAccessProxy(name, config.tailscale.services, dnsSuffix, NAMESPACE, provider, [nsResource]);
  }

  // Split DNS — deploy CoreDNS + configure Tailscale API
  if (config.dns?.enabled) {
    const dns = deployAccessDns(name, prefix, config.dns, NAMESPACE, provider, [nsResource]);

    // Automatically configure Tailscale split DNS via API
    new TailscaleSplitDns(
      `${name}-tailscale-split-dns`,
      {
        oauthClientId: config.tailscale.oauthClientId,
        oauthClientSecret: config.tailscale.oauthClientSecret,
        domain: dns.zone,
        nameservers: [dns.clusterIp],
      },
      { dependsOn: [helmRelease] }
    );
  }

  return {
    name,
    provider: "tailscale",
    namespace: NAMESPACE,
    helmRelease,
  };
}
