/**
 * Shared split DNS for access gateway providers.
 *
 * Deploys a CoreDNS instance that resolves
 * <service>.<namespace>.<prefix>.<tld> → cluster service IPs.
 *
 * @module access/dns
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IAccessDnsConfig } from "./interfaces";

/** CoreDNS deployment output. */
export interface IAccessDns {
  readonly service: k8s.core.v1.Service;
  readonly clusterIp: pulumi.Output<string>;
  readonly zone: string;
}

/**
 * Build CoreDNS Corefile for the access gateway zone.
 *
 * Rewrites <svc>.<ns>.<prefix>.<tld> → <svc>.<ns>.svc.cluster.local
 * via the template plugin, then forwards to cluster DNS.
 */
function buildCorefile(prefix: string, tld: string): string {
  const zone = `${prefix}.${tld}`;
  // Escape dots for regex
  const prefixEsc = prefix.replace(/\./g, "\\.");
  const tldEsc = tld.replace(/\./g, "\\.");
  return `${zone}:53 {
    rewrite name regex ([a-z0-9-]+)\\.${prefixEsc}\\.${tldEsc} access-proxy.access.svc.cluster.local answer auto
    forward . /etc/resolv.conf
    cache 60
    errors
    log
}
`;
}

/**
 * Deploy CoreDNS for access gateway split DNS.
 */
export function deployAccessDns(
  name: string,
  prefix: string,
  dnsConfig: IAccessDnsConfig,
  namespace: string,
  provider: k8s.Provider,
  dependsOn?: pulumi.Resource[]
): IAccessDns {
  const tld = dnsConfig.tld ?? "internal";
  const zone = `${prefix}.${tld}`;

  const corefile = new k8s.core.v1.ConfigMap(
    `${name}-access-dns-corefile`,
    {
      metadata: { name: "access-dns-corefile", namespace },
      data: { Corefile: buildCorefile(prefix, tld) },
    },
    { provider, dependsOn }
  );

  const labels = { app: "access-dns", "app.kubernetes.io/managed-by": "nimbus" };

  new k8s.apps.v1.Deployment(
    `${name}-access-dns`,
    {
      metadata: { name: "access-dns", namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                name: "coredns",
                image: "coredns/coredns:1.12.0",
                args: ["-conf", "/etc/coredns/Corefile"],
                ports: [
                  { name: "dns", containerPort: 53, protocol: "UDP" },
                  { name: "dns-tcp", containerPort: 53, protocol: "TCP" },
                ],
                volumeMounts: [
                  { name: "corefile", mountPath: "/etc/coredns", readOnly: true },
                ],
                resources: {
                  requests: { cpu: "10m", memory: "16Mi" },
                  limits: { cpu: "50m", memory: "64Mi" },
                },
              },
            ],
            volumes: [
              { name: "corefile", configMap: { name: "access-dns-corefile" } },
            ],
          },
        },
      },
    },
    { provider, dependsOn: [corefile] }
  );

  const service = new k8s.core.v1.Service(
    `${name}-access-dns-svc`,
    {
      metadata: { name: "access-dns", namespace },
      spec: {
        selector: labels,
        ports: [
          { name: "dns", port: 53, targetPort: 53, protocol: "UDP" },
          { name: "dns-tcp", port: 53, targetPort: 53, protocol: "TCP" },
        ],
      },
    },
    { provider }
  );

  return {
    service,
    clusterIp: service.spec.clusterIP,
    zone,
  };
}
