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
import type {
  IDeschedulerConfig,
  IExternalDnsConfig,
  IPlatformComponentConfig,
  IPlatformStack,
  IPlatformStackConfig,
  IVaultConfig,
} from "./interfaces";
import { assertNever } from "../types";
import { ensureNamespace } from "../utils/ensure-namespace";

/** Number of Vault replicas in HA mode (Raft consensus requires odd count). */
const VAULT_HA_REPLICAS = 3;

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
    components["traefik"] = deployTraefik(name, config.traefik, provider);
  }

  // 2. cert-manager (TLS certificates) — enabled by default
  if (config.certManager?.enabled !== false) {
    components["cert-manager"] = deployCertManager(name, config.certManager, provider);
  }

  // 3. External DNS — enabled if configured
  if (config.externalDns && config.externalDns.enabled !== false) {
    const dnsConfig = config.externalDns;

    // 3a. Route53 IAM provisioning — create IAM user + access key when no manual credentials
    if (dnsConfig.dnsProvider === "route53" && !dnsConfig.dnsCredentials) {
      const awsRegion = dnsConfig.awsRegion ?? "us-east-1";
      const awsOpts = dnsConfig.awsProvider ? { provider: dnsConfig.awsProvider } : {};

      const iamUser = new aws.iam.User(`${name}-external-dns-user`, {
        name: `${name}-external-dns`,
        path: "/nimbus/",
      }, awsOpts);

      new aws.iam.UserPolicy(`${name}-external-dns-policy`, {
        user: iamUser.name,
        policy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: [
                "route53:ChangeResourceRecordSets",
                "route53:ListResourceRecordSets",
              ],
              Resource: "arn:aws:route53:::hostedzone/*",
            },
            {
              Effect: "Allow",
              Action: [
                "route53:ListHostedZones",
                "route53:ListHostedZonesByName",
              ],
              Resource: "*",
            },
          ],
        }),
      }, awsOpts);

      const accessKey = new aws.iam.AccessKey(`${name}-external-dns-key`, {
        user: iamUser.name,
      }, awsOpts);

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
          dependsOn: [components["cert-manager"]].filter(
            Boolean
          ) as k8s.helm.v3.Release[],
        }
      );

      // Deploy external-dns with env vars referencing the K8s secret
      components["external-dns"] = deployExternalDns(name, dnsConfig, provider, [
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
          dependsOn: [components["cert-manager"]].filter(
            Boolean
          ) as k8s.helm.v3.Release[],
        }
      );
    } else {
      components["external-dns"] = deployExternalDns(name, dnsConfig, provider);
    }
  }

  // 4. ArgoCD (GitOps) — optional
  if (config.argocd?.enabled) {
    components["argocd"] = deployArgocd(name, config.argocd, config.domain, provider);
  }

  // 5. Vault (secrets) — optional
  if (config.vault?.enabled) {
    components["vault"] = deployVault(name, config.vault, provider);
  }

  // 6. External Secrets Operator — optional
  if (config.externalSecrets?.enabled) {
    components["external-secrets"] = deployExternalSecrets(name, config.externalSecrets, provider);
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
        dependsOn: [components["cert-manager"]].filter(
          Boolean
        ) as k8s.helm.v3.Release[],
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

  // 9. OAuth2 Proxy — optional, protects dashboards
  if (config.oauth2Proxy?.enabled) {
    components["oauth2-proxy"] = deployOAuth2Proxy(
      name,
      config.oauth2Proxy,
      config.domain,
      provider
    );
  }

  // 10. OAuth2 Proxy ingress + Traefik dashboard IngressRoute
  if (components["traefik"] && components["oauth2-proxy"]) {
    // OAuth2 callback ingress
    new k8s.networking.v1.Ingress(
      `${name}-oauth2-ingress`,
      {
        metadata: {
          name: "oauth2-proxy",
          namespace: "traefik",
          annotations: { "traefik.ingress.kubernetes.io/router.entrypoints": "websecure" },
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
    new k8s.apiextensions.CustomResource(
      `${name}-forwardauth-middleware`,
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "Middleware",
        metadata: { name: "oauth2-forward-auth", namespace: "traefik" },
        spec: {
          forwardAuth: {
            address: "http://oauth2-proxy.traefik.svc.cluster.local:4180/oauth2/auth",
            trustForwardHeader: true,
            authResponseHeaders: [
              "X-Auth-Request-User",
              "X-Auth-Request-Email",
            ],
          },
        },
      },
      { provider, dependsOn: [components["traefik"]] }
    );

    // StripPrefix middleware for /dashboard
    new k8s.apiextensions.CustomResource(
      `${name}-strip-dashboard-prefix`,
      {
        apiVersion: "traefik.io/v1alpha1",
        kind: "Middleware",
        metadata: { name: "strip-dashboard-prefix", namespace: "traefik" },
        spec: {
          stripPrefix: { prefixes: ["/dashboard"] },
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
              match: `Host(\`traefik.${config.domain}\`) && PathPrefix(\`/dashboard\`)`,
              kind: "Rule",
              middlewares: [
                { name: "oauth2-forward-auth" },
                { name: "strip-dashboard-prefix" },
              ],
              services: [
                { name: "api@internal", kind: "TraefikService" },
              ],
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
                        auth: Buffer.from(`${username}:${password}`).toString(
                          "base64"
                        ),
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
    components["descheduler"] = deployDescheduler(
      name,
      config.descheduler,
      provider
    );
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
                  role: "external-secrets",
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

  return {
    name,
    cluster,
    components,
    traefikEndpoint,
  };
}

function deployTraefik(
  name: string,
  config: IPlatformComponentConfig | undefined,
  provider: k8s.Provider
): k8s.helm.v3.Release {
  return new k8s.helm.v3.Release(
    `${name}-traefik`,
    {
      chart: "traefik",
      repositoryOpts: { repo: "https://traefik.github.io/charts" },
      version: config?.version ?? DEFAULT_VERSIONS.traefik,
      namespace: "traefik",
      createNamespace: true,
      values: {
        ingressRoute: {
          dashboard: { enabled: false },
        },
        ports: {
          web: { redirectTo: { port: "websecure" } },
          websecure: { tls: { enabled: true } },
        },
        providers: {
          kubernetesIngress: { publishedService: { enabled: true } },
        },
        ...config?.values,
      },
    },
    { provider }
  );
}

function deployCertManager(
  name: string,
  config: IPlatformComponentConfig | undefined,
  provider: k8s.Provider
): k8s.helm.v3.Release {
  return new k8s.helm.v3.Release(
    `${name}-cert-manager`,
    {
      chart: "cert-manager",
      repositoryOpts: { repo: "https://charts.jetstack.io" },
      version: config?.version ?? DEFAULT_VERSIONS.certManager,
      namespace: "cert-manager",
      createNamespace: true,
      values: {
        crds: { enabled: true },
        ...config?.values,
      },
    },
    { provider }
  );
}

function deployExternalDns(
  name: string,
  config: IExternalDnsConfig,
  provider: k8s.Provider,
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
    sources: ["ingress", "service"],
    ...config.values,
  };

  if (envOverrides) {
    values["env"] = envOverrides;
  }

  return new k8s.helm.v3.Release(
    `${name}-external-dns`,
    {
      chart: "external-dns",
      repositoryOpts: { repo: "https://kubernetes-sigs.github.io/external-dns" },
      version: config.version ?? DEFAULT_VERSIONS.externalDns,
      namespace: "external-dns",
      createNamespace: true,
      values,
    },
    { provider }
  );
}

function deployArgocd(
  name: string,
  config: IPlatformComponentConfig,
  domain: string,
  provider: k8s.Provider
): k8s.helm.v3.Release {
  return new k8s.helm.v3.Release(
    `${name}-argocd`,
    {
      chart: "argo-cd",
      repositoryOpts: { repo: "https://argoproj.github.io/argo-helm" },
      version: config.version ?? DEFAULT_VERSIONS.argocd,
      namespace: "argocd",
      createNamespace: true,
      values: {
        server: {
          ingress: {
            enabled: true,
            ingressClassName: "traefik",
            hostname: `argocd.${domain}`,
            tls: true,
          },
        },
        ...config.values,
      },
    },
    { provider }
  );
}

function deployVault(
  name: string,
  config: IVaultConfig,
  provider: k8s.Provider
): k8s.helm.v3.Release {
  const ha = config.ha ?? false;
  const storageSize = config.storageSize ?? "5Gi";

  const serverValues: Record<string, unknown> = {
    standalone: { enabled: !ha },
    ha: ha
      ? {
          enabled: true,
          replicas: VAULT_HA_REPLICAS,
          raft: { enabled: true },
        }
      : { enabled: false },
    dataStorage: { size: storageSize },
  };

  if (config.ingressHost) {
    serverValues["ingress"] = {
      enabled: true,
      ingressClassName: "traefik",
      hosts: [{ host: config.ingressHost }],
      tls: [{ hosts: [config.ingressHost], secretName: "vault-tls" }],
    };
  }

  return new k8s.helm.v3.Release(
    `${name}-vault`,
    {
      chart: "vault",
      repositoryOpts: { repo: "https://helm.releases.hashicorp.com" },
      version: config.version ?? DEFAULT_VERSIONS.vault,
      namespace: "vault",
      createNamespace: true,
      values: {
        server: serverValues,
        injector: { enabled: true },
        ...config.values,
      },
    },
    { provider }
  );
}

function deployExternalSecrets(
  name: string,
  config: IPlatformComponentConfig,
  provider: k8s.Provider
): k8s.helm.v3.Release {
  return new k8s.helm.v3.Release(
    `${name}-external-secrets`,
    {
      chart: "external-secrets",
      repositoryOpts: { repo: "https://charts.external-secrets.io" },
      version: config.version ?? DEFAULT_VERSIONS.externalSecrets,
      namespace: "external-secrets",
      createNamespace: true,
      values: {
        crds: { createClusterExternalSecret: true, createClusterSecretStore: true },
        ...config.values,
      },
    },
    { provider }
  );
}

function deployOAuth2Proxy(
  name: string,
  config: IPlatformComponentConfig & {
    readonly provider: "google" | "github" | "azure";
    readonly clientId: pulumi.Input<string>;
    readonly clientSecret: pulumi.Input<string>;
  },
  domain: string,
  provider: k8s.Provider
): k8s.helm.v3.Release {
  // Generate a deterministic cookie secret from the stack name via SHA-256.
  // In production, override via config.values.config.cookieSecret.
  const cookieSecret = pulumi
    .output(name)
    .apply((n) => {
      const { createHash } = require("crypto") as typeof import("crypto");
      return createHash("sha256").update(`${n}-oauth2-proxy-cookie`).digest("base64").slice(0, 32);
    });

  return new k8s.helm.v3.Release(
    `${name}-oauth2-proxy`,
    {
      chart: "oauth2-proxy",
      repositoryOpts: { repo: "https://oauth2-proxy.github.io/manifests" },
      version: config.version ?? DEFAULT_VERSIONS.oauth2Proxy,
      namespace: "traefik",
      createNamespace: true,
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
          "upstream": "static://202",
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

function deployDescheduler(
  name: string,
  config: IDeschedulerConfig,
  provider: k8s.Provider
): k8s.helm.v3.Release {
  const strategies = config.strategies ?? [
    "RemoveDuplicates",
    "LowNodeUtilization",
    "RemovePodsViolatingNodeAffinity",
  ];

  const strategyValues: Record<string, { enabled: boolean }> = {};
  for (const strategy of strategies) {
    strategyValues[strategy] = { enabled: true };
  }

  return new k8s.helm.v3.Release(
    `${name}-descheduler`,
    {
      chart: "descheduler",
      repositoryOpts: {
        repo: "https://kubernetes-sigs.github.io/descheduler",
      },
      version: config.version ?? DEFAULT_VERSIONS.descheduler,
      namespace: "kube-system",
      createNamespace: false,
      values: {
        deschedulerPolicy: { strategies: strategyValues },
        ...config.values,
      },
    },
    { provider }
  );
}
