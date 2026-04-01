/**
 * Platform stack implementation — deploys Helm-based platform components
 * to any ICluster.
 *
 * Components: Traefik, cert-manager, External DNS, ArgoCD, Vault,
 * External Secrets Operator, OAuth2 Proxy, Descheduler, and more.
 *
 * @module platform/stack
 */

import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { ICluster } from "../cluster";
import { createPrometheusRule } from "../observability/alerts";
import type {
  IPlatformStack,
  IPlatformStackConfig,
} from "./interfaces";
import type { IExposedService } from "../types";
import { ensureNamespace } from "../utils/ensure-namespace";
import {
  deployTraefik,
  deployCertManager,
  deployExternalDns,
  deployArgocd,
  deployVault,
  deployExternalSecrets,
  deployOAuth2Proxy,
  deployDescheduler,
} from "./components";

/**
 * Default Helm chart versions. Used only when the consumer doesn't pass `version`.
 * Set to `undefined` to let Helm resolve the latest available version.
 */
const DEFAULT_VERSIONS: Record<string, string | undefined> = {
  traefik: undefined,
  certManager: undefined,
  externalDns: undefined,
  argocd: undefined,
  vault: undefined,
  externalSecrets: undefined,
  oauth2Proxy: undefined,
  descheduler: undefined,
};

/**
 * Deploy a platform stack to one or more clusters.
 *
 * Installs cloud-agnostic Helm releases for ingress, TLS, DNS, GitOps,
 * secrets management, and more. Each component can be individually
 * enabled/disabled and configured.
 *
 * @example
 * ```typescript
 * const platform = createPlatformStack("prod", {
 *   cluster,
 *   domain: "reyem.tech",
 *   externalDns: {
 *     dnsProvider: "route53",
 *     domainFilters: ["reyem.tech"],
 *   },
 *   vault: { enabled: true, ingressHost: "vault.reyem.tech" },
 * });
 * ```
 *
 * @param name - Stack name prefix for all resources
 * @param config - Platform stack configuration
 * @returns Deployed platform stack(s)
 */
export function createPlatformStack(
  name: string,
  config: IPlatformStackConfig
): IPlatformStack | IPlatformStack[] {
  const clusters = Array.isArray(config.cluster) ? config.cluster : [config.cluster];

  if (clusters.length === 1) {
    return deployToCluster(name, config, clusters[0] as ICluster);
  }

  return clusters.map((cluster, i) =>
    deployToCluster(`${name}-${cluster.name || i}`, config, cluster)
  );
}

function deployToCluster(
  name: string,
  config: IPlatformStackConfig,
  cluster: ICluster
): IPlatformStack {
  const components: Record<string, k8s.helm.v3.Release> = {};
  const provider = cluster.provider;

  // 1. Traefik (ingress controller) — enabled by default
  if (config.traefik?.enabled !== false) {
    components["traefik"] = deployTraefik(name, config.traefik, provider, DEFAULT_VERSIONS.traefik, config.robotsBlock);

    // Traefik alert rules
    createPrometheusRule(`${name}-traefik-alerts`, "observability", [
      {
        name: "nimbus.traefik",
        rules: [
          {
            alert: "TraefikDown",
            expr: `kube_deployment_status_replicas_available{namespace="traefik",deployment=~".*traefik.*"} == 0`,
            for: "2m",
            labels: { severity: "critical" },
            annotations: { summary: "Traefik ingress controller has 0 available replicas — all traffic stopped" },
          },
          {
            alert: "TraefikHighErrorRate",
            expr: `sum(rate(traefik_service_requests_total{code=~"5.."}[5m])) / sum(rate(traefik_service_requests_total[5m])) > 0.05`,
            for: "5m",
            labels: { severity: "warning" },
            annotations: { summary: "Traefik 5xx error rate is above 5% ({{ $value | humanizePercentage }})" },
          },
        ],
      },
    ], provider, [components["traefik"]]);
  }

  // 2. cert-manager (TLS certificates) — enabled by default
  if (config.certManager?.enabled !== false) {
    components["cert-manager"] = deployCertManager(name, config.certManager, provider, DEFAULT_VERSIONS.certManager);
  }

  // 3. External DNS — enabled if configured
  if (config.externalDns && config.externalDns.enabled !== false) {
    const dnsConfig = config.externalDns;

    // 3a. Route53 IAM provisioning — create IAM user + access key when no manual credentials
    if (dnsConfig.dnsProvider === "route53" && !dnsConfig.dnsCredentials) {
      const awsRegion = dnsConfig.awsRegion ?? "us-east-1";
      const awsOpts = dnsConfig.awsProvider ? { provider: dnsConfig.awsProvider } : {};

      const iamUser = new aws.iam.User(
        `${name}-external-dns-user`,
        {
          name: `${name}-external-dns`,
          path: "/nimbus/",
        },
        awsOpts
      );

      new aws.iam.UserPolicy(
        `${name}-external-dns-policy`,
        {
          user: iamUser.name,
          policy: JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: ["route53:ChangeResourceRecordSets", "route53:ListResourceRecordSets"],
                Resource: "arn:aws:route53:::hostedzone/*",
              },
              {
                Effect: "Allow",
                Action: ["route53:GetChange"],
                Resource: "arn:aws:route53:::change/*",
              },
              {
                Effect: "Allow",
                Action: ["route53:ListHostedZones", "route53:ListHostedZonesByName"],
                Resource: "*",
              },
            ],
          }),
        },
        awsOpts
      );

      const accessKey = new aws.iam.AccessKey(
        `${name}-external-dns-key`,
        {
          user: iamUser.name,
        },
        awsOpts
      );

      // Secret for external-dns namespace
      new k8s.core.v1.Secret(
        `${name}-route53-external-dns`,
        {
          metadata: { name: "route53-credentials", namespace: "external-dns" },
          stringData: {
            AWS_ACCESS_KEY_ID: accessKey.id,
            AWS_SECRET_ACCESS_KEY: accessKey.secret,
          },
        },
        { provider }
      );

      // Secret for cert-manager namespace (DNS-01 solver)
      new k8s.core.v1.Secret(
        `${name}-route53-cert-manager`,
        {
          metadata: { name: "route53-credentials", namespace: "cert-manager" },
          stringData: {
            "secret-access-key": accessKey.secret,
          },
        },
        {
          provider,
          dependsOn: [components["cert-manager"]].filter(Boolean) as k8s.helm.v3.Release[],
        }
      );

      // Deploy external-dns with env vars referencing the K8s secret
      components["external-dns"] = deployExternalDns(name, dnsConfig, provider, DEFAULT_VERSIONS.externalDns, [
        {
          name: "AWS_ACCESS_KEY_ID",
          valueFrom: {
            secretKeyRef: { name: "route53-credentials", key: "AWS_ACCESS_KEY_ID" },
          },
        },
        {
          name: "AWS_SECRET_ACCESS_KEY",
          valueFrom: {
            secretKeyRef: { name: "route53-credentials", key: "AWS_SECRET_ACCESS_KEY" },
          },
        },
        { name: "AWS_REGION", value: awsRegion },
      ]);

      // ClusterIssuer for DNS-01 validation via Route53
      new k8s.apiextensions.CustomResource(
        `${name}-clusterissuer-dns`,
        {
          apiVersion: "cert-manager.io/v1",
          kind: "ClusterIssuer",
          metadata: { name: "letsencrypt-dns" },
          spec: {
            acme: {
              email: `contact@${config.domain}`,
              server: "https://acme-v02.api.letsencrypt.org/directory",
              privateKeySecretRef: { name: "letsencrypt-dns-account-key" },
              solvers: [
                {
                  dns01: {
                    route53: {
                      region: awsRegion,
                      accessKeyID: accessKey.id,
                      secretAccessKeySecretRef: {
                        name: "route53-credentials",
                        key: "secret-access-key",
                      },
                    },
                  },
                },
              ],
            },
          },
        },
        {
          provider,
          dependsOn: [components["cert-manager"]].filter(Boolean) as k8s.helm.v3.Release[],
        }
      );
    } else {
      components["external-dns"] = deployExternalDns(name, dnsConfig, provider, DEFAULT_VERSIONS.externalDns);
    }
  }

  // 4. ArgoCD (GitOps) — optional
  if (config.argocd?.enabled) {
    components["argocd"] = deployArgocd(name, config.argocd, config.domain, provider, DEFAULT_VERSIONS.argocd);
  }

  // 5. Vault (secrets) — optional
  if (config.vault?.enabled) {
    components["vault"] = deployVault(name, config.vault, config.domain, provider, DEFAULT_VERSIONS.vault);
  }

  // 6. External Secrets Operator — optional
  if (config.externalSecrets?.enabled) {
    components["external-secrets"] = deployExternalSecrets(name, config.externalSecrets, provider, DEFAULT_VERSIONS.externalSecrets);
  }

  // 7. Wildcard certificate — auto-created when cert-manager is enabled
  if (config.certManager?.enabled !== false) {
    const certName = config.domain.replace(/\./g, "-");
    new k8s.apiextensions.CustomResource(
      `${name}-wildcard-cert`,
      {
        apiVersion: "cert-manager.io/v1",
        kind: "Certificate",
        metadata: { name: `${certName}-wildcard`, namespace: "traefik" },
        spec: {
          secretName: `${certName}-wildcard-tls`,
          issuerRef: { name: "letsencrypt-dns", kind: "ClusterIssuer" },
          dnsNames: [config.domain, `*.${config.domain}`],
        },
      },
      {
        provider,
        dependsOn: [components["cert-manager"]].filter(Boolean) as k8s.helm.v3.Release[],
      }
    );
  }

  // 8. Default TLSStore — sets wildcard cert as default for Traefik
  if (components["traefik"] && config.certManager?.enabled !== false) {
    const certName = config.domain.replace(/\./g, "-");
    new k8s.apiextensions.CustomResource(
      `${name}-default-tlsstore`,
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "TLSStore",
        metadata: { name: "default", namespace: "traefik" },
        spec: {
          defaultCertificate: { secretName: `${certName}-wildcard-tls` },
        },
      },
      { provider, dependsOn: [components["traefik"]] }
    );
  }

  // 9. OAuth2 Proxy — only needed when dashboards are NOT exposed via Tailscale
  if (config.oauth2Proxy?.enabled && config.traefik?.expose === false) {
    components["oauth2-proxy"] = deployOAuth2Proxy(
      name,
      config.oauth2Proxy,
      config.domain,
      provider,
      DEFAULT_VERSIONS.oauth2Proxy
    );
  }

  // 10. OAuth2 Proxy ingress + Traefik dashboard IngressRoute
  // Skip when exposed via Tailscale (default)
  if (components["traefik"] && components["oauth2-proxy"]) {
    // OAuth2 callback ingress
    new k8s.networking.v1.Ingress(
      `${name}-oauth2-ingress`,
      {
        metadata: {
          name: "oauth2-proxy",
          namespace: "traefik",
          annotations: {
            "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
            "pulumi.com/skipAwait": "true",
          },
        },
        spec: {
          ingressClassName: "traefik",
          rules: [
            {
              host: `traefik.${config.domain}`,
              http: {
                paths: [
                  {
                    path: "/oauth2",
                    pathType: "Prefix",
                    backend: {
                      service: {
                        name: components["oauth2-proxy"].status.apply(
                          (s) => s?.name ?? "oauth2-proxy"
                        ),
                        port: { number: 4180 },
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      },
      { provider, dependsOn: [components["oauth2-proxy"]] }
    );

    // ForwardAuth middleware pointing to OAuth2 proxy
    const oauth2SvcName = components["oauth2-proxy"].status.apply((s) => s?.name ?? "oauth2-proxy");
    new k8s.apiextensions.CustomResource(
      `${name}-forwardauth-middleware`,
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "Middleware",
        metadata: { name: "oauth2-forward-auth", namespace: "traefik" },
        spec: {
          forwardAuth: {
            address: pulumi.interpolate`http://${oauth2SvcName}.traefik.svc.cluster.local:4180/oauth2/auth`,
            trustForwardHeader: true,
            authResponseHeaders: ["X-Auth-Request-User", "X-Auth-Request-Email"],
          },
        },
      },
      { provider, dependsOn: [components["traefik"]] }
    );

    // IngressRoute for Traefik dashboard behind ForwardAuth
    new k8s.apiextensions.CustomResource(
      `${name}-dashboard-ingressroute`,
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "IngressRoute",
        metadata: { name: "traefik-dashboard", namespace: "traefik" },
        spec: {
          entryPoints: ["websecure"],
          routes: [
            {
              match: `Host(\`traefik.${config.domain}\`) && (PathPrefix(\`/dashboard\`) || PathPrefix(\`/api\`))`,
              kind: "Rule",
              middlewares: [{ name: "oauth2-forward-auth" }],
              services: [{ name: "api@internal", kind: "TraefikService" }],
            },
          ],
        },
      },
      {
        provider,
        dependsOn: [components["traefik"], components["oauth2-proxy"]],
      }
    );
  }

  // 11. Robot blocking header — for staging environments
  if (config.robotsBlock && components["traefik"]) {
    new k8s.apiextensions.CustomResource(
      `${name}-robots-block`,
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "Middleware",
        metadata: { name: "robots-block", namespace: "traefik" },
        spec: {
          headers: {
            customResponseHeaders: {
              "X-Robots-Tag": "noindex, nofollow",
            },
          },
        },
      },
      { provider, dependsOn: [components["traefik"]] }
    );
  }

  // 12. Image pull secrets — replicated to specified namespaces
  if (config.imagePullSecrets) {
    for (const secret of config.imagePullSecrets) {
      const namespaces = secret.namespaces ?? ["default"];
      for (const ns of namespaces) {
        const nsResource = ensureNamespace(ns, provider);
        const secretName = `${secret.registry.replace(/[^a-z0-9]/gi, "-")}-pull-secret`;
        new k8s.core.v1.Secret(
          `${name}-pull-${secretName}-${ns}`,
          {
            metadata: { name: secretName, namespace: ns },
            type: "kubernetes.io/dockerconfigjson",
            stringData: {
              ".dockerconfigjson": pulumi
                .all([secret.username, secret.password, secret.email ?? ""])
                .apply(([username, password, email]) =>
                  JSON.stringify({
                    auths: {
                      [secret.registry]: {
                        username,
                        password,
                        email,
                        auth: Buffer.from(`${username}:${password}`).toString("base64"),
                      },
                    },
                  })
                ),
            },
          },
          { provider, dependsOn: [nsResource] }
        );
      }
    }
  }

  // 13. Descheduler — pod rebalancing for spot instances
  if (config.descheduler?.enabled) {
    components["descheduler"] = deployDescheduler(name, config.descheduler, provider, DEFAULT_VERSIONS.descheduler);
  }

  // 14. ClusterSecretStore — connects ESO to Vault
  if (components["vault"] && components["external-secrets"]) {
    new k8s.apiextensions.CustomResource(
      `${name}-cluster-secret-store`,
      {
        apiVersion: "external-secrets.io/v1",
        kind: "ClusterSecretStore",
        metadata: { name: "vault-backend" },
        spec: {
          provider: {
            vault: {
              server: `https://vault.${config.domain}`,
              path: "secret",
              version: "v2",
              auth: {
                kubernetes: {
                  mountPath: "kubernetes",
                  role: "eso",
                },
              },
            },
          },
        },
      },
      {
        provider,
        dependsOn: [components["vault"], components["external-secrets"]],
        customTimeouts: { create: "5m" },
      }
    );
  }

  const traefikEndpoint = components["traefik"]
    ? components["traefik"].status.apply((s) => {
        const lb = s?.namespace ?? "";
        return lb;
      })
    : pulumi.output("pending");

  // Collect exposed services
  const exposedServices: IExposedService[] = [];

  if (components["traefik"] && config.traefik?.expose !== false) {
    const originalName = components["traefik"].status.apply((s) => s?.name ?? "");
    exposedServices.push({ name: "traefik", originalName, namespace: "traefik", port: 9100, label: "traefik" });
  }

  if (components["vault"] && config.vault?.expose !== false) {
    const originalName = components["vault"].status.apply((s) => s?.name ?? "");
    exposedServices.push({ name: "vault", originalName, namespace: "vault", port: 8200, label: "vault" });
  }

  if (components["argocd"] && config.argocd?.expose !== false) {
    const originalName = components["argocd"].status.apply((s) => s?.name ?? "");
    const serverName = originalName.apply((r) => `${r}-server`);
    exposedServices.push({ name: "argocd", originalName: serverName, namespace: "argocd", port: 80, label: "argocd" });
  }

  return {
    name,
    cluster,
    components,
    traefikEndpoint,
    exposedServices,
  };
}
