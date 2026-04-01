/**
 * Reverse proxy for access gateway service exposure.
 *
 * Deploys a lightweight Nginx pod that routes by Host header
 * to backend services, providing port 80 access to services
 * running on non-standard ports (Prometheus :9090, Vault :8200, etc.).
 *
 * All services are accessed via: <label>.iad-1.internal:80
 *
 * @module access/proxy
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IExposedService } from "../types";

/**
 * Build Nginx config from exposed services.
 *
 * Each service gets a server block matching its label as the hostname.
 * All listen on port 80, proxy to the real service's port.
 */
function buildNginxConfig(
  services: ReadonlyArray<IExposedService>,
  dnsSuffix: string
): pulumi.Output<string> {
  const serviceConfigs = services.map((svc) => {
    const upstream = pulumi
      .output(svc.originalName ?? svc.name)
      .apply(
        (name) =>
          `${name}.${svc.namespace}.svc.cluster.local:${svc.port}`
      );

    return upstream.apply(
      (u) => `    server {
        listen 80;
        server_name ${svc.label}.${dnsSuffix};

        location / {
            proxy_pass http://${u};
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection "upgrade";
        }
    }`
    );
  });

  return pulumi.all(serviceConfigs).apply(
    (blocks) => `events {
    worker_connections 256;
}

http {
    resolver kube-dns.kube-system.svc.cluster.local valid=10s;

${blocks.join("\n\n")}

    # Default — return 404 for unknown hosts
    server {
        listen 80 default_server;
        return 404;
    }
}
`
  );
}

/**
 * Deploy the access proxy — Nginx reverse proxy for exposed services.
 *
 * Returns the proxy ClusterIP service name for CoreDNS to resolve to.
 */
export function deployAccessProxy(
  name: string,
  services: ReadonlyArray<IExposedService>,
  dnsSuffix: string,
  namespace: string,
  provider: k8s.Provider,
  dependsOn?: pulumi.Resource[]
): k8s.core.v1.Service {
  const labels = {
    app: "access-proxy",
    "app.kubernetes.io/managed-by": "nimbus",
  };

  const configMap = new k8s.core.v1.ConfigMap(
    `${name}-access-proxy-config`,
    {
      metadata: { name: "access-proxy-config", namespace },
      data: {
        "nginx.conf": buildNginxConfig(services, dnsSuffix),
      },
    },
    { provider, dependsOn }
  );

  new k8s.apps.v1.Deployment(
    `${name}-access-proxy`,
    {
      metadata: { name: "access-proxy", namespace },
      spec: {
        replicas: 1,
        selector: { matchLabels: labels },
        template: {
          metadata: { labels },
          spec: {
            containers: [
              {
                name: "nginx",
                image: "nginx:alpine",
                ports: [{ name: "http", containerPort: 80 }],
                volumeMounts: [
                  {
                    name: "config",
                    mountPath: "/etc/nginx/nginx.conf",
                    subPath: "nginx.conf",
                    readOnly: true,
                  },
                ],
                resources: {
                  requests: { cpu: "5m", memory: "8Mi" },
                  limits: { cpu: "50m", memory: "32Mi" },
                },
              },
            ],
            volumes: [
              {
                name: "config",
                configMap: { name: "access-proxy-config" },
              },
            ],
          },
        },
      },
    },
    { provider, dependsOn: [configMap] }
  );

  return new k8s.core.v1.Service(
    `${name}-access-proxy-svc`,
    {
      metadata: { name: "access-proxy", namespace },
      spec: {
        selector: labels,
        ports: [{ name: "http", port: 80, targetPort: 80 }],
      },
    },
    { provider }
  );
}
