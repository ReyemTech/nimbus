/**
 * Unit tests for platform stack deploy logic.
 *
 * Tests the deployToCluster function's component routing for descheduler,
 * OAuth2 proxy, and conditional component creation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockOutput = (val: unknown): any => ({
  apply: (fn: (v: unknown) => unknown) => mockOutput(fn(val)),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockProvider = (): any => ({});

// Track created resources
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdReleases: Array<{ name: string; args: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdCustomResources: Array<{ name: string; args: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdSecrets: Array<{ name: string; args: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdIngresses: Array<{ name: string; args: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdIamUsers: Array<{ name: string; args: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdIamPolicies: Array<{ name: string; args: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdIamAccessKeys: Array<{ name: string; args: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdDaemonSets: Array<{ name: string; args: any }>;

// Mock @pulumi/aws
vi.mock("@pulumi/aws", () => {
  const mockIamUser = class {
    name: ReturnType<typeof mockOutput>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdIamUsers.push({ name, args });
      this.name = mockOutput(args.name);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockUserPolicy = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdIamPolicies.push({ name, args });
    }
  };

  const mockAccessKey = class {
    id: ReturnType<typeof mockOutput>;
    secret: ReturnType<typeof mockOutput>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdIamAccessKeys.push({ name, args });
      this.id = mockOutput("AKIAIOSFODNN7EXAMPLE");
      this.secret = mockOutput("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    }
  };

  return {
    iam: {
      User: mockIamUser,
      UserPolicy: mockUserPolicy,
      AccessKey: mockAccessKey,
    },
  };
});

// Mock @pulumi/kubernetes
vi.mock("@pulumi/kubernetes", () => {
  const mockRelease = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    status: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdReleases.push({ name, args });
      this.status = mockOutput({ namespace: "mock-ns" });
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockCustomResource = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdCustomResources.push({ name, args });
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockSecret = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdSecrets.push({ name, args });
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockIngress = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdIngresses.push({ name, args });
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockDaemonSet = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdDaemonSets.push({ name, args });
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockConfigMap = class {};

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockNamespace = class {};

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockLimitRange = class {};

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockClusterRoleBinding = class {};

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockRole = class {};

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockRoleBinding = class {};

  return {
    helm: { v3: { Release: mockRelease } },
    apiextensions: { CustomResource: mockCustomResource },
    apps: { v1: { DaemonSet: mockDaemonSet } },
    core: {
      v1: {
        Secret: mockSecret,
        ConfigMap: mockConfigMap,
        Namespace: mockNamespace,
        LimitRange: mockLimitRange,
      },
    },
    networking: { v1: { Ingress: mockIngress } },
    rbac: {
      v1: {
        ClusterRoleBinding: mockClusterRoleBinding,
        Role: mockRole,
        RoleBinding: mockRoleBinding,
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    Provider: class {},
  };
});

// Mock @pulumi/pulumi
vi.mock("@pulumi/pulumi", () => ({
  output: (val: unknown) => mockOutput(val),
  all: (vals: unknown[]) => ({
    apply: (fn: (...args: unknown[]) => unknown) => mockOutput(fn(vals)),
  }),
  interpolate: (strings: TemplateStringsArray, ...values: unknown[]) =>
    mockOutput(strings.reduce((acc, str, i) => acc + str + (values[i] ?? ""), "")),
}));

import { createPlatformStack } from "../../src/platform/stack";
import type { ICluster } from "../../src/cluster";

function makeCluster(name: string): ICluster {
  return {
    name,
    cloud: { provider: "aws", region: "us-east-1" },
    endpoint: mockOutput("https://mock"),
    kubeconfig: mockOutput("{}"),
    version: mockOutput("1.32"),
    nodePools: [],
    nativeResource: {} as ICluster["nativeResource"],
    provider: mockProvider(),
  };
}

beforeEach(() => {
  createdReleases = [];
  createdCustomResources = [];
  createdSecrets = [];
  createdIngresses = [];
  createdIamUsers = [];
  createdIamPolicies = [];
  createdIamAccessKeys = [];
  createdDaemonSets = [];
});

describe("platform stack — descheduler", () => {
  it("deploys descheduler when enabled", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      traefik: { enabled: false },
      certManager: { enabled: false },
      descheduler: { enabled: true },
    });

    const deschedulerRelease = createdReleases.find((r) => r.name.includes("descheduler"));
    expect(deschedulerRelease).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(deschedulerRelease!.args.chart).toBe("descheduler");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(deschedulerRelease!.args.namespace).toBe("kube-system");
  });

  it("uses default strategies when none specified", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      traefik: { enabled: false },
      certManager: { enabled: false },
      descheduler: { enabled: true },
    });

    const deschedulerRelease = createdReleases.find((r) => r.name.includes("descheduler"));
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const strategies = (deschedulerRelease!.args.values as Record<string, unknown>)[
      "deschedulerPolicy"
    ] as Record<string, unknown>;
    const strategyMap = strategies["strategies"] as Record<string, unknown>;
    expect(strategyMap).toHaveProperty("RemoveDuplicates");
    expect(strategyMap).toHaveProperty("LowNodeUtilization");
    expect(strategyMap).toHaveProperty("RemovePodsViolatingNodeAffinity");
  });

  it("does not deploy descheduler when not configured", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      traefik: { enabled: false },
      certManager: { enabled: false },
    });

    const deschedulerRelease = createdReleases.find((r) => r.name.includes("descheduler"));
    expect(deschedulerRelease).toBeUndefined();
  });

  it("does not deploy descheduler when enabled is false", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      traefik: { enabled: false },
      certManager: { enabled: false },
      descheduler: { enabled: false },
    });

    const deschedulerRelease = createdReleases.find((r) => r.name.includes("descheduler"));
    expect(deschedulerRelease).toBeUndefined();
  });
});

describe("platform stack — oauth2 proxy", () => {
  it("deploys oauth2 proxy when configured", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      certManager: { enabled: false },
      oauth2Proxy: {
        enabled: true,
        provider: "google",
        clientId: "my-client-id",
        clientSecret: "my-client-secret",
      },
    });

    const oauth2Release = createdReleases.find((r) => r.name.includes("oauth2-proxy"));
    expect(oauth2Release).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(oauth2Release!.args.chart).toBe("oauth2-proxy");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(oauth2Release!.args.namespace).toBe("traefik");
  });

  it("does not deploy oauth2 proxy when not configured", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      traefik: { enabled: false },
      certManager: { enabled: false },
    });

    const oauth2Release = createdReleases.find((r) => r.name.includes("oauth2-proxy"));
    expect(oauth2Release).toBeUndefined();
  });

  it("creates dashboard IngressRoute when both traefik and oauth2 proxy are deployed", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      certManager: { enabled: false },
      oauth2Proxy: {
        enabled: true,
        provider: "github",
        clientId: "id",
        clientSecret: "secret",
      },
    });

    const dashboardRoute = createdCustomResources.find((r) => r.args.kind === "IngressRoute");
    expect(dashboardRoute).toBeDefined();

    const forwardAuth = createdCustomResources.find(
      (r) => r.args.kind === "Middleware" && r.args.metadata?.name === "oauth2-forward-auth"
    );
    expect(forwardAuth).toBeDefined();
  });
});

describe("platform stack — robots block", () => {
  it("creates robots-block middleware when robotsBlock is true", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      certManager: { enabled: false },
      robotsBlock: true,
    });

    const robotsMiddleware = createdCustomResources.find(
      (r) => r.args.kind === "Middleware" && r.args.metadata?.name === "robots-block"
    );
    expect(robotsMiddleware).toBeDefined();
  });

  it("does not create robots-block middleware when robotsBlock is false", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      certManager: { enabled: false },
      robotsBlock: false,
    });

    const robotsMiddleware = createdCustomResources.find(
      (r) => r.args.kind === "Middleware" && r.args.metadata?.name === "robots-block"
    );
    expect(robotsMiddleware).toBeUndefined();
  });
});

describe("platform stack — wildcard cert and TLSStore", () => {
  it("creates wildcard cert when cert-manager is enabled", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "reyem.tech",
    });

    const wildcardCert = createdCustomResources.find((r) => r.args.kind === "Certificate");
    expect(wildcardCert).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(wildcardCert!.args.spec.dnsNames).toEqual(["reyem.tech", "*.reyem.tech"]);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(wildcardCert!.args.spec.secretName).toBe("reyem-tech-wildcard-tls");
  });

  it("creates default TLSStore when traefik and cert-manager are enabled", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "reyem.tech",
    });

    const tlsStore = createdCustomResources.find((r) => r.args.kind === "TLSStore");
    expect(tlsStore).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(tlsStore!.args.spec.defaultCertificate.secretName).toBe("reyem-tech-wildcard-tls");
  });
});

describe("platform stack — Route53 IAM auto-provisioning", () => {
  it("creates IAM user, policy, access key, and K8s secrets when route53 without manual credentials", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "reyem.tech",
      externalDns: {
        dnsProvider: "route53",
        domainFilters: ["reyem.tech"],
        awsRegion: "us-east-1",
      },
    });

    expect(createdIamUsers).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(createdIamUsers[0]!.args.path).toBe("/nimbus/");
    expect(createdIamPolicies).toHaveLength(1);
    expect(createdIamAccessKeys).toHaveLength(1);

    // Two K8s secrets: one for external-dns, one for cert-manager
    const route53Secrets = createdSecrets.filter(
      (s) => s.args.metadata?.name === "route53-credentials"
    );
    expect(route53Secrets).toHaveLength(2);

    const ednsSecret = route53Secrets.find((s) => s.args.metadata?.namespace === "external-dns");
    expect(ednsSecret).toBeDefined();

    const cmSecret = route53Secrets.find((s) => s.args.metadata?.namespace === "cert-manager");
    expect(cmSecret).toBeDefined();
  });

  it("creates ClusterIssuer for DNS-01 when route53 IAM is auto-provisioned", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "reyem.tech",
      externalDns: {
        dnsProvider: "route53",
        domainFilters: ["reyem.tech"],
      },
    });

    const issuer = createdCustomResources.find(
      (r) => r.args.kind === "ClusterIssuer" && r.args.metadata?.name === "letsencrypt-dns"
    );
    expect(issuer).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(issuer!.args.spec.acme.solvers[0].dns01.route53.region).toBe("us-east-1");
  });

  it("sets env overrides on external-dns helm values for route53", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "reyem.tech",
      certManager: { enabled: false },
      externalDns: {
        dnsProvider: "route53",
        domainFilters: ["reyem.tech"],
      },
    });

    const ednsRelease = createdReleases.find((r) => r.name.includes("external-dns"));
    expect(ednsRelease).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const env = (ednsRelease!.args.values as Record<string, unknown>)["env"] as Array<
      Record<string, unknown>
    >;
    expect(env).toHaveLength(3);
    expect(env.map((e) => e["name"])).toEqual([
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_REGION",
    ]);
  });

  it("skips IAM provisioning when manual dnsCredentials are provided", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "reyem.tech",
      certManager: { enabled: false },
      externalDns: {
        dnsProvider: "route53",
        dnsCredentials: { AWS_ACCESS_KEY_ID: "manual", AWS_SECRET_ACCESS_KEY: "manual" },
        domainFilters: ["reyem.tech"],
      },
    });

    expect(createdIamUsers).toHaveLength(0);
    expect(createdIamAccessKeys).toHaveLength(0);

    // No route53-credentials secrets
    const route53Secrets = createdSecrets.filter(
      (s) => s.args.metadata?.name === "route53-credentials"
    );
    expect(route53Secrets).toHaveLength(0);
  });

  it("defaults awsRegion to us-east-1 when not specified", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "reyem.tech",
      externalDns: {
        dnsProvider: "route53",
        domainFilters: ["reyem.tech"],
      },
    });

    const issuer = createdCustomResources.find(
      (r) => r.args.kind === "ClusterIssuer" && r.args.metadata?.name === "letsencrypt-dns"
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(issuer!.args.spec.acme.solvers[0].dns01.route53.region).toBe("us-east-1");
  });
});

describe("platform stack — ClusterSecretStore", () => {
  it("creates ClusterSecretStore when both vault and ESO are deployed", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "reyem.tech",
      certManager: { enabled: false },
      vault: { enabled: true },
      externalSecrets: { enabled: true },
    });

    const css = createdCustomResources.find((r) => r.args.kind === "ClusterSecretStore");
    expect(css).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(css!.args.spec.provider.vault.server).toBe("https://vault.reyem.tech");
  });

  it("does not create ClusterSecretStore when vault is missing", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "reyem.tech",
      certManager: { enabled: false },
      externalSecrets: { enabled: true },
    });

    const css = createdCustomResources.find((r) => r.args.kind === "ClusterSecretStore");
    expect(css).toBeUndefined();
  });
});

describe("platform stack — image pruner", () => {
  it("creates image pruner DaemonSet by default", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", { cluster, domain: "example.com" });
    expect(createdDaemonSets.some((d) => d.args.metadata.name === "image-pruner")).toBe(true);
  });

  it("skips image pruner when imagePruner.enabled is false", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      imagePruner: { enabled: false },
    });
    expect(createdDaemonSets.some((d) => d.args.metadata.name === "image-pruner")).toBe(false);
  });
});
