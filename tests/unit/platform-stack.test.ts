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

  const mockCustomResource = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdCustomResources.push({ name, args });
    }
  };

  const mockSecret = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdSecrets.push({ name, args });
    }
  };

  const mockIngress = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdIngresses.push({ name, args });
    }
  };

  return {
    helm: { v3: { Release: mockRelease } },
    apiextensions: { CustomResource: mockCustomResource },
    core: { v1: { Secret: mockSecret } },
    networking: { v1: { Ingress: mockIngress } },
    Provider: class {},
  };
});

// Mock @pulumi/pulumi
vi.mock("@pulumi/pulumi", () => ({
  output: (val: unknown) => mockOutput(val),
  all: (vals: unknown[]) => ({
    apply: (fn: (...args: unknown[]) => unknown) => mockOutput(fn(vals)),
  }),
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
    expect(deschedulerRelease!.args.chart).toBe("descheduler");
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
    const strategies = (deschedulerRelease!.args.values as Record<string, unknown>)["deschedulerPolicy"] as Record<string, unknown>;
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
    expect(oauth2Release!.args.chart).toBe("oauth2-proxy");
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

    const dashboardRoute = createdCustomResources.find(
      (r) => r.args.kind === "IngressRoute"
    );
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

    const wildcardCert = createdCustomResources.find(
      (r) => r.args.kind === "Certificate"
    );
    expect(wildcardCert).toBeDefined();
    expect(wildcardCert!.args.spec.dnsNames).toEqual(["reyem.tech", "*.reyem.tech"]);
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
    expect(tlsStore!.args.spec.defaultCertificate.secretName).toBe("reyem-tech-wildcard-tls");
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

    const css = createdCustomResources.find(
      (r) => r.args.kind === "ClusterSecretStore"
    );
    expect(css).toBeDefined();
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

    const css = createdCustomResources.find(
      (r) => r.args.kind === "ClusterSecretStore"
    );
    expect(css).toBeUndefined();
  });
});
