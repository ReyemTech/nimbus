/**
 * Shared split DNS for access gateway providers.
 *
 * Two resolution paths:
 * - Web services (proxied): grafana.iad-1.internal → Nginx proxy (port 80)
 * - Data services (direct): mariadb-main.data.iad-1.internal → ClusterIP (native port)
 *
 * @module access/dns
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IAccessDnsConfig } from "./interfaces";
import type { IExposedService } from "../types";

/** CoreDNS deployment output. */
export interface IAccessDns {
  readonly service: k8s.core.v1.Service;
  readonly clusterIp: pulumi.Output<string>;
  readonly zone: string;
}

/**
 * Build CoreDNS Corefile with two resolution paths:
 *
 * 1. Per-service rewrites for proxied web services:
 *    grafana.iad-1.internal → access-proxy.access.svc.cluster.local
 *
 * 2. Catch-all regex for direct access (with namespace):
 *    mariadb-main.data.iad-1.internal → mariadb-main.data.svc.cluster.local
 */
function buildCorefile(
  prefix: string,
  tld: string,
  proxiedServices: ReadonlyArray<IExposedService>
): pulumi.Output<string> {
  const zone = `${prefix}.${tld}`;
  const prefixEsc = prefix.replace(/\./g, "\\.");
  const tldEsc = tld.replace(/\./g, "\\.");

  // Build per-service rewrite rules for proxied services
  // CoreDNS exact name rewrite: rewrite name exact <from> <to>
  const proxyRewrites = proxiedServices.map(
    (svc) =>
      `    rewrite name exact ${svc.label}.${prefix}.${tld} access-proxy.access.svc.cluster.local`
  );

  return pulumi.output(proxyRewrites).apply(
    (rewrites) =>
      `${zone}:53 {
    # Proxied web services → Nginx reverse proxy (port 80)
${rewrites.join("\n")}

    # Direct access: <service>.<namespace>.iad-1.internal → <service>.<namespace>.svc.cluster.local
    rewrite name regex ([a-z0-9-]+)\\.([a-z0-9-]+)\\.${prefixEsc}\\.${tldEsc} {1}.{2}.svc.cluster.local answer auto

    forward . /etc/resolv.conf
    cache 60
    errors
    log
}
`
  );
}

/**
 * Deploy CoreDNS for access gateway split DNS.
 *
 * @param proxiedServices - Services routed through the Nginx proxy (web UIs)
 */
export function deployAccessDns(
  name: string,
  prefix: string,
  dnsConfig: IAccessDnsConfig,
  namespace: string,
  provider: k8s.Provider,
  proxiedServices: ReadonlyArray<IExposedService>,
  dependsOn?: pulumi.Resource[]
): IAccessDns {
  const tld = dnsConfig.tld ?? "internal";
  const zone = `${prefix}.${tld}`;

  const corefile = new k8s.core.v1.ConfigMap(
    `${name}-access-dns-corefile`,
    {
      metadata: { name: "access-dns-corefile", namespace },
      data: { Corefile: buildCorefile(prefix, tld, proxiedServices) },
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
                volumeMounts: [{ name: "corefile", mountPath: "/etc/coredns", readOnly: true }],
                resources: {
                  requests: { cpu: "10m", memory: "16Mi" },
                  limits: { cpu: "50m", memory: "64Mi" },
                },
              },
            ],
            volumes: [{ name: "corefile", configMap: { name: "access-dns-corefile" } }],
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
