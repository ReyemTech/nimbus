/**
 * Unit tests for platform stack deploy logic.
 *
 * Tests the deployToCluster function's component routing for descheduler,
 * OAuth2 proxy, and conditional component creation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type * as pulumi from "@pulumi/pulumi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockOutput = (val: unknown): any => ({
  apply: (fn: (v: unknown) => unknown) => mockOutput(fn(val)),
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockProvider = (): any => ({});

// Track created resources
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdReleases: Array<{ name: string; args: any; opts: any; resource?: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdCustomResources: Array<{ name: string; args: any; opts?: any }>;
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
let createdPodIdentityAssociations: Array<{ name: string; args: any; opts: any; resource: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdDaemonSets: Array<{ name: string; args: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdDeployments: Array<{ name: string; args: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdDeploymentPatches: Array<{ name: string; args: any; opts: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdConfigMaps: Array<{ name: string; args: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdClusterRoles: Array<{ name: string; args: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdClusterRoleBindings: Array<{ name: string; args: any; opts?: any; resource: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdCustomResourcesForAssertions: Array<{ name: string; args: any; opts?: any }>;

// Mock @pulumi/aws
vi.mock("@pulumi/aws", () => {
  const mockEksCluster = class {
    name = mockOutput("test-cluster");
    arn = mockOutput("arn:aws:eks:us-east-1:123456789012:cluster/test-cluster");
  };
  const mockRoute53Zone = class {
    zoneId = mockOutput("Z-CREATED");
  };
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockRoute53ZoneAssociation = class {};
  const mockAddon = class {
    name: ReturnType<typeof mockOutput>;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, _args: any, _opts?: any) {
      this.name = mockOutput(name);
    }
  };
  const mockIdentityAssociation = class {
    associationId = mockOutput("association-id");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, opts: any) {
      createdPodIdentityAssociations.push({ name, args, opts, resource: this });
    }
  };
  const mockIamRole = class {
    arn = mockOutput("arn:aws:iam::123456789012:role/external-dns");
    id = mockOutput("external-dns");
  };
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockIamRolePolicy = class {};
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
    eks: {
      Cluster: mockEksCluster,
      Addon: mockAddon,
      PodIdentityAssociation: mockIdentityAssociation,
    },
    iam: {
      User: mockIamUser,
      UserPolicy: mockUserPolicy,
      AccessKey: mockAccessKey,
      Role: mockIamRole,
      RolePolicy: mockIamRolePolicy,
    },
    getPartitionOutput: () => mockOutput({ partition: "aws" }),
    getCallerIdentityOutput: () => mockOutput({ accountId: "123456789012" }),
    route53: {
      getZoneOutput: () => mockOutput({ zoneId: "Z123" }),
      Zone: mockRoute53Zone,
      ZoneAssociation: mockRoute53ZoneAssociation,
    },
  };
});

// Mock @pulumi/kubernetes
vi.mock("@pulumi/kubernetes", () => {
  const mockRelease = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    status: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, opts?: any) {
      createdReleases.push({ name, args, opts, resource: this });
      this.status = mockOutput({ namespace: "mock-ns" });
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockCustomResource = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, opts?: any) {
      createdCustomResources.push({ name, args, opts });
      createdCustomResourcesForAssertions.push({ name, args, opts });
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
  const mockDeployment = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdDeployments.push({ name, args });
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockDeploymentPatch = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, opts?: any) {
      createdDeploymentPatches.push({ name, args, opts });
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockConfigMap = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdConfigMaps.push({ name, args });
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockPodDisruptionBudget = class {};

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockNamespace = class {};

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockLimitRange = class {};

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockClusterRoleBinding = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, opts?: any) {
      createdClusterRoleBindings.push({ name, args, opts, resource: this });
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockClusterRole = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdClusterRoles.push({ name, args });
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockRole = class {};

  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockRoleBinding = class {};

  return {
    helm: { v3: { Release: mockRelease } },
    policy: { v1: { PodDisruptionBudget: mockPodDisruptionBudget } },
    apiextensions: { CustomResource: mockCustomResource },
    apps: {
      v1: {
        DaemonSet: mockDaemonSet,
        Deployment: mockDeployment,
        DeploymentPatch: mockDeploymentPatch,
      },
    },
    core: {
      v1: {
        Secret: mockSecret,
        ConfigMap: mockConfigMap,
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        ServiceAccount: class {},
        // eslint-disable-next-line @typescript-eslint/no-extraneous-class
        Service: class {},
        Namespace: mockNamespace,
        LimitRange: mockLimitRange,
      },
    },
    networking: { v1: { Ingress: mockIngress } },
    rbac: {
      v1: {
        ClusterRoleBinding: mockClusterRoleBinding,
        ClusterRole: mockClusterRole,
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
  rootStackResource: {},
  output: (val: unknown) => mockOutput(val),
  all: (vals: unknown[]) => ({
    apply: (fn: (...args: unknown[]) => unknown) => mockOutput(fn(vals)),
  }),
  interpolate: (strings: TemplateStringsArray, ...values: unknown[]) =>
    mockOutput(strings.reduce((acc, str, i) => acc + str + (values[i] ?? ""), "")),
  secret: (val: unknown) => ({ __secret: val }),
}));

import { createPlatformStack } from "../../src/platform/stack";
import type { ICluster } from "../../src/cluster";
import type { IPlatformStack } from "../../src/platform";
import * as aws from "@pulumi/aws";

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
  createdPodIdentityAssociations = [];
  createdDaemonSets = [];
  createdDeployments = [];
  createdDeploymentPatches = [];
  createdConfigMaps = [];
  createdClusterRoles = [];
  createdClusterRoleBindings = [];
  createdCustomResourcesForAssertions = [];
});

describe("platform stack — ArgoCD values", () => {
  it("forwards explicit dependencies to the Traefik release", () => {
    const prerequisite = {} as pulumi.Resource;
    createPlatformStack("test", {
      cluster: makeCluster("test"),
      domain: "example.com",
      traefik: { dependsOn: [prerequisite] },
      certManager: { enabled: false },
    });
    expect(
      createdReleases.find((release) => release.name === "test-traefik")?.opts.dependsOn
    ).toContain(prerequisite);
  });

  it("merges caller config maps with Nimbus defaults", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      traefik: { enabled: false },
      certManager: { enabled: false },
      argocd: {
        enabled: true,
        values: {
          configs: {
            cm: { "resource.exclusions": "- apiGroups: [aquasecurity.github.io]" },
          },
        },
      },
    });

    const release = createdReleases.find((item) => item.name === "test-argocd");
    expect(release).toBeDefined();
    if (!release) throw new Error("ArgoCD release was not created");
    const values = release.args.values as {
      configs: { params: Record<string, unknown>; cm: Record<string, string> };
      server: { ingress: { hostname: string } };
    };
    expect(values.configs.params["server.insecure"]).toBe(true);
    expect(values.configs.cm["resource.exclusions"]).toContain("aquasecurity.github.io");
    expect(values.server.ingress.hostname).toBe("argocd.example.com");
  });
});

describe("platform stack — Headlamp dashboard", () => {
  it("does not install Headlamp unless enabled", () => {
    const platform = createPlatformStack("test", {
      cluster: makeCluster("test"),
      domain: "example.com",
      certManager: { enabled: false },
      traefik: { enabled: false },
    });

    expect(createdReleases.some((release) => release.name === "test-headlamp")).toBe(false);
    expect((platform as IPlatformStack).components.headlamp).toBeUndefined();
    expect((platform as IPlatformStack).exposedServices).toEqual([]);
  });

  it("infers installed plugins, orders after platform releases, and exposes Headlamp by default", () => {
    const platform = createPlatformStack("test", {
      cluster: makeCluster("test"),
      domain: "example.com",
      traefik: { enabled: false },
      argocd: { enabled: true },
      headlamp: { enabled: true },
    });

    const release = createdReleases.find((item) => item.name === "test-headlamp");
    expect(release).toBeDefined();
    const configContent = release?.args.values.pluginsManager.configContent as string;
    expect(configContent).toContain("headlamp_cert-manager");
    expect(configContent).toContain("headlamp-argocd");
    expect(release?.opts.dependsOn).toContain(
      createdReleases.find((item) => item.name === "test-cert-manager")?.resource
    );
    expect(release?.opts.dependsOn).toContain(
      createdReleases.find((item) => item.name === "test-argocd")?.resource
    );
    expect((platform as IPlatformStack).exposedServices).toContainEqual({
      name: "headlamp",
      originalName: "headlamp",
      namespace: "headlamp",
      port: 80,
      label: "headlamp",
    });
  });

  it("keeps the service private and allows opting out of Tailscale exposure", () => {
    const platform = createPlatformStack("test", {
      cluster: makeCluster("test"),
      domain: "example.com",
      traefik: { enabled: false },
      certManager: { enabled: false },
      headlamp: { enabled: true, expose: false },
    });

    const release = createdReleases.find((item) => item.name === "test-headlamp");
    expect(release?.args.values.service.type).toBe("ClusterIP");
    expect(release?.args.values.ingress.enabled).toBe(false);
    expect((platform as IPlatformStack).exposedServices).toEqual([]);
  });
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

describe("platform stack — Trivy Operator", () => {
  it("deploys continuous workload scanning when enabled", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      traefik: { enabled: false },
      certManager: { enabled: false },
      trivyOperator: { enabled: true },
    });

    const trivyRelease = createdReleases.find((r) => r.name.includes("trivy-operator"));
    expect(trivyRelease).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(trivyRelease!.args.chart).toBe("trivy-operator");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(trivyRelease!.args.namespace).toBe("trivy-system");
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect((trivyRelease!.args.values as Record<string, unknown>).trivy).toEqual({
      ignoreUnfixed: false,
    });
  });

  it("does not deploy Trivy Operator unless enabled", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      traefik: { enabled: false },
      certManager: { enabled: false },
    });

    expect(createdReleases.find((r) => r.name.includes("trivy-operator"))).toBeUndefined();
  });
});

describe("platform stack — Trivy exposure classifier", () => {
  it("deploys a non-root read-only metrics exporter with read-only RBAC", () => {
    const cluster = makeCluster("test");
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      traefik: { enabled: false },
      certManager: { enabled: false },
      trivyExposureClassifier: { enabled: true },
    });

    const deployment = createdDeployments.find((resource) =>
      resource.name.includes("trivy-exposure-classifier")
    );
    expect(deployment).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const pod = deployment!.args.spec.template.spec;
    expect(pod.securityContext.runAsNonRoot).toBe(true);
    expect(pod.containers[0].securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
      capabilities: { drop: ["ALL"] },
    });

    expect(createdClusterRoles).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(createdClusterRoles[0]!.args.rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resources: ["vulnerabilityreports"], verbs: ["get", "list"] }),
        expect.objectContaining({ resources: ["services"], verbs: ["get", "list"] }),
        expect.objectContaining({ resources: ["ingresses"], verbs: ["get", "list"] }),
      ])
    );
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(createdConfigMaps[0]!.args.data["classifier.js"]).toContain(
      "nimbus_trivy_vulnerability_findings"
    );
    expect(
      createdCustomResourcesForAssertions.find(
        (resource) => resource.args.kind === "ServiceMonitor"
      )
    ).toBeDefined();
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
  it("switches to isolated Helm controllers and registers private-zone resources when configured", () => {
    const cluster = {
      ...makeCluster("test"),
      nativeResource: new aws.eks.Cluster("test", {} as aws.eks.ClusterArgs),
      awsVpcId: mockOutput("vpc-123"),
      awsRegion: "us-east-1",
      providerResources: { podIdentityAgent: {} as pulumi.Resource },
    } as unknown as ICluster;
    const platform = createPlatformStack("test", {
      cluster,
      domain: "example.com",
      traefik: { enabled: false },
      certManager: { enabled: false },
      externalDns: {
        dnsProvider: "route53",
        hostedZoneIds: ["Z-PUBLIC"],
        domainFilters: ["example.com"],
        route53: { privateHostedZones: [{ mode: "create", prefix: "cac-1" }] },
      },
    }) as IPlatformStack;

    expect(createdReleases.filter((release) => release.name.includes("external-dns"))).toHaveLength(
      2
    );
    expect(platform.components["external-dns-public"]).toBeDefined();
    expect(platform.components["external-dns-private"]).toBeDefined();
    expect(platform.providerResources?.["external-dns"]).toBeUndefined();
    expect(platform.providerResources?.["external-dns-0"]).toBeDefined();
    expect(platform.providerResources?.["route53-private-zone-0"]).toBeDefined();
    expect(createdPodIdentityAssociations.map((identity) => identity.args.namespace)).toEqual(
      expect.arrayContaining(["external-dns-public", "external-dns-private"])
    );
  });

  it("uses public DNS for cert-manager DNS01 checks when split Route 53 zones are enabled", () => {
    const cluster = {
      ...makeCluster("test"),
      nativeResource: new aws.eks.Cluster("test", {} as aws.eks.ClusterArgs),
      awsVpcId: mockOutput("vpc-123"),
      awsRegion: "ca-central-1",
      providerResources: { podIdentityAgent: {} as pulumi.Resource },
    } as unknown as ICluster;
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      traefik: { enabled: false },
      certManager: { values: { extraArgs: ["--v=2"] } },
      externalDns: {
        dnsProvider: "route53",
        hostedZoneIds: ["Z-PUBLIC"],
        domainFilters: ["example.com"],
        route53: { privateHostedZones: [{ mode: "create", prefix: "cac-1" }] },
      },
    });

    const certManagerRelease = createdReleases.find(
      (release) => release.name === "test-cert-manager"
    );
    expect(certManagerRelease?.args.values.extraArgs).toEqual([
      "--v=2",
      "--dns01-recursive-nameservers-only",
      "--dns01-recursive-nameservers=1.1.1.1:53,8.8.8.8:53",
    ]);
    const issuer = createdCustomResources.find(
      (resource) =>
        resource.args.kind === "ClusterIssuer" && resource.args.metadata?.name === "letsencrypt-dns"
    );
    expect(issuer?.args.spec.acme.solvers[0].dns01.route53).toEqual({
      region: "ca-central-1",
      hostedZoneID: "Z-PUBLIC",
    });
  });

  it("rejects split Route 53 DNS with EKS-managed cert-manager", () => {
    const cluster = {
      ...makeCluster("test"),
      nativeResource: new aws.eks.Cluster("test", {} as aws.eks.ClusterArgs),
      awsVpcId: mockOutput("vpc-123"),
      awsRegion: "ca-central-1",
      eksAddons: ["cert-manager"],
    } as unknown as ICluster;

    expect(() =>
      createPlatformStack("test", {
        cluster,
        domain: "example.com",
        traefik: { enabled: false },
        externalDns: {
          dnsProvider: "route53",
          hostedZoneIds: ["Z-PUBLIC"],
          domainFilters: ["example.com"],
          route53: { privateHostedZones: [{ mode: "create", prefix: "cac-1" }] },
        },
      })
    ).toThrow(/requires Helm-managed cert-manager/);
  });

  it("uses the effective cert-manager service account and rolls pods after Pod Identity is ready", () => {
    const cluster = {
      ...makeCluster("test"),
      nativeResource: new aws.eks.Cluster("test", {
        roleArn: "test-role",
        vpcConfig: { subnetIds: [] },
      }),
    } as unknown as ICluster;
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      traefik: { enabled: false },
      certManager: {
        values: { serviceAccount: { name: "cert-manager-custom" } },
      },
      externalDns: { dnsProvider: "route53", hostedZoneIds: ["Z123"] },
    });
    const association = createdPodIdentityAssociations.find(
      (item) => item.args.namespace === "cert-manager"
    );
    const release = createdReleases.find((item) => item.name === "test-cert-manager");
    expect(association?.args.serviceAccount).toBe("cert-manager-custom");
    expect(release?.args.values.serviceAccount.name).toBe("cert-manager-custom");
    expect(release?.opts.dependsOn).toContain(association?.resource);
    expect(release?.args.values.podAnnotations["nimbus.dev/route53-pod-identity"]).toBe(
      association?.resource.associationId
    );
  });

  it("uses the stable default cert-manager service account for Route 53 Pod Identity", () => {
    const cluster = {
      ...makeCluster("test"),
      nativeResource: new aws.eks.Cluster("test", {
        roleArn: "test-role",
        vpcConfig: { subnetIds: [] },
      }),
    } as unknown as ICluster;
    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      traefik: { enabled: false },
      externalDns: { dnsProvider: "route53", hostedZoneIds: ["Z123"] },
    });
    const association = createdPodIdentityAssociations.find(
      (item) => item.args.namespace === "cert-manager"
    );
    const release = createdReleases.find((item) => item.name === "test-cert-manager");
    expect(association?.args.serviceAccount).toBe("cert-manager");
    expect(release?.args.values.serviceAccount.name).toBe("cert-manager");
  });

  it("uses native EKS resources without static AWS users, access keys, or Kubernetes Secrets", () => {
    const cluster = {
      ...makeCluster("test"),
      nativeResource: new aws.eks.Cluster("test", {
        roleArn: "test-role",
        vpcConfig: { subnetIds: [] },
      }),
    } as unknown as ICluster;
    const result = createPlatformStack("test", {
      cluster,
      domain: "example.com",
      traefik: { enabled: false },
      certManager: { enabled: false },
      externalDns: { dnsProvider: "route53", hostedZoneIds: ["Z123"] },
    }) as { providerResources?: Record<string, unknown> };
    expect(createdIamUsers).toHaveLength(0);
    expect(createdIamAccessKeys).toHaveLength(0);
    expect(createdSecrets).toHaveLength(0);
    expect(result.providerResources?.["external-dns"]).toBeDefined();
  });

  it("creates the Route 53 ClusterIssuer when cert-manager is an EKS add-on", () => {
    const cluster = {
      ...makeCluster("test"),
      nativeResource: new aws.eks.Cluster("test", {
        roleArn: "test-role",
        vpcConfig: { subnetIds: [] },
      }),
      eksAddons: ["cert-manager"],
    } as unknown as ICluster;

    createPlatformStack("test", {
      cluster,
      domain: "example.com",
      traefik: { enabled: false },
      externalDns: { dnsProvider: "route53", hostedZoneIds: ["Z123"] },
    });

    expect(createdReleases.some((release) => release.name === "test-cert-manager")).toBe(false);
    const issuer = createdCustomResources.find(
      (resource) =>
        resource.args.kind === "ClusterIssuer" && resource.args.metadata?.name === "letsencrypt-dns"
    );
    expect(issuer).toBeDefined();
    expect(issuer?.opts?.dependsOn).toContain(cluster.provider);
    expect(
      createdCustomResources.some(
        (resource) =>
          resource.args.kind === "Certificate" && resource.args.metadata?.namespace === "traefik"
      )
    ).toBe(true);
    const rolloutPatch = createdDeploymentPatches.find(
      (patch) => patch.args.metadata?.name === "cert-manager"
    );
    expect(rolloutPatch?.args.metadata.namespace).toBe("cert-manager");
    expect(
      rolloutPatch?.args.spec.template.metadata.annotations["nimbus.dev/route53-pod-identity"]
    ).toBe(
      createdPodIdentityAssociations.find(
        (association) => association.args.namespace === "cert-manager"
      )?.resource.associationId
    );
    expect(rolloutPatch?.opts.dependsOn).toContain(
      createdPodIdentityAssociations.find(
        (association) => association.args.namespace === "cert-manager"
      )?.resource
    );
  });

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
        values: { env: [{ name: "CUSTOM_FLAG", value: "enabled" }] },
      },
    });

    const ednsRelease = createdReleases.find((r) => r.name.includes("external-dns"));
    expect(ednsRelease).toBeDefined();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const env = (ednsRelease!.args.values as Record<string, unknown>)["env"] as Array<
      Record<string, unknown>
    >;
    expect(env).toHaveLength(4);
    expect(env).toContainEqual({ name: "CUSTOM_FLAG", value: "enabled" });
    expect(env.map((e) => e["name"])).toEqual([
      "CUSTOM_FLAG",
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
      vault: {
        enabled: true,
        secretMount: "kv-prod",
        esoSecretPaths: ["argocd/ghcr-reyemtech"],
        esoKubernetesAuthAudience: "eso.example.com",
      },
      externalSecrets: { enabled: true },
    });

    const css = createdCustomResources.find((r) => r.args.kind === "ClusterSecretStore");
    if (!css) throw new Error("ClusterSecretStore was not created");
    expect(css.args.spec.provider.vault.server).toBe("https://vault.reyem.tech");
    expect(css.args.spec.provider.vault.auth.kubernetes).toMatchObject({
      mountPath: "kubernetes",
      role: "eso",
      serviceAccountRef: {
        name: "external-secrets",
        namespace: "external-secrets",
        audiences: ["eso.example.com"],
      },
    });

    const bootstrap = createdConfigMaps.find(
      (resource) => resource.name === "test-vault-bootstrap-script"
    );
    if (!bootstrap) throw new Error("Vault bootstrap ConfigMap was not created");
    const script = bootstrap.args.data["bootstrap.sh"] as string;
    expect(script).toContain("bound_service_account_names=external-secrets");
    expect(script).toContain("bound_service_account_namespaces=external-secrets");
    expect(script).toContain("audience=eso.example.com");
    expect(script).toContain("audience=vault");
    expect(script).toMatch(
      /vault policy write eso - <<'EOPOLICY'\npath "kv-prod\/data\/argocd\/ghcr-reyemtech" \{ capabilities = \["read"\] \}\nEOPOLICY/
    );
    expect(css.args.spec.provider.vault.path).toBe("kv-prod");
    expect(script).not.toContain("token_reviewer_jwt=");
    expect(script).not.toContain("vault auth disable");
    expect(script).toContain("vault token revoke -self");
    expect(script).toContain("auth/kubernetes/role/vault-root-recovery");
    expect(script).toContain("ttl=15m");
    expect(script).toContain("token_max_ttl=15m");
    expect(script).toContain("token_no_default_policy=true");
    expect(script).toContain(
      'path "sys/generate-root/attempt" { capabilities = ["create", "update", "read", "delete"] }'
    );
    expect(script).toContain(
      'path "sys/generate-root/update" { capabilities = ["create", "update"] }'
    );
    const bootstrapPolicy = script.match(
      /vault policy write vault-bootstrap - <<'EOPOLICY'\n([\s\S]*?)\nEOPOLICY/
    )?.[1];
    expect(bootstrapPolicy).toBeDefined();
    expect(bootstrapPolicy).not.toContain("sys/generate-root");
    expect(script).toContain("auth/kubernetes/login");
    expect(script).toContain("/var/run/vault-bootstrap-token/token");
    expect(script).toContain('INIT_OUTPUT_TMP_FILE="${INIT_OUTPUT_FILE}.tmp"');
    expect(script).toContain('> "$INIT_OUTPUT_TMP_FILE"');
    expect(script).toContain('mv "$INIT_OUTPUT_TMP_FILE" "$INIT_OUTPUT_FILE"');
    expect(script).toContain('ROOT_TOKEN=$(json_field "$(cat "$INIT_OUTPUT_FILE")" root_token)');
    expect(script).toContain('RECOVERY_KEYS=$(json_array "$INIT_OUTPUT" recovery_keys_b64)');
    expect(script).toContain("vault token lookup >/dev/null 2>&1");
    expect(script).toContain(
      'rm -f "$LEGACY_TOKEN_FILE" "$INIT_OUTPUT_FILE" "$INIT_OUTPUT_TMP_FILE"'
    );
    expect(script).not.toContain('echo "$ROOT_TOKEN"');

    const configMapName = bootstrap.args.metadata.name as string;
    expect(configMapName).toMatch(/^vault-bootstrap-[a-f0-9]{12}$/);
    type MockVaultValues = {
      server: {
        volumes: Array<{
          name: string;
          configMap?: { name: string };
          projected?: { sources: Array<{ serviceAccountToken: object }> };
        }>;
        extraContainers: Array<{ volumeMounts: object[] }>;
        serviceAccount: { name: string };
        updateStrategyType: string;
      };
    };
    const vaultValues = createdReleases.find((release) => release.name === "test-vault")?.args
      .values as MockVaultValues;
    const scriptVolume = vaultValues.server.volumes[0];
    if (!scriptVolume?.configMap) throw new Error("Bootstrap script volume was not created");
    expect(scriptVolume.configMap.name).toBe(configMapName);
    const bootstrapTokenVolume = vaultValues.server.volumes.find(
      (volume) => volume.name === "vault-bootstrap-token"
    );
    if (!bootstrapTokenVolume?.projected) throw new Error("Bootstrap token volume was not created");
    const tokenSource = bootstrapTokenVolume.projected.sources[0];
    if (!tokenSource) throw new Error("Projected token source was not created");
    expect(tokenSource.serviceAccountToken).toEqual({
      audience: "vault",
      expirationSeconds: 3600,
      path: "token",
    });
    const bootstrapContainer = vaultValues.server.extraContainers[0];
    if (!bootstrapContainer) throw new Error("Vault bootstrap sidecar was not created");
    expect(bootstrapContainer.volumeMounts).toContainEqual({
      name: "vault-bootstrap-token",
      mountPath: "/var/run/vault-bootstrap-token",
      readOnly: true,
    });
    expect(vaultValues.server.serviceAccount.name).toBe("vault");
    expect(vaultValues.server.updateStrategyType).toBe("RollingUpdate");
    expect(
      createdClusterRoleBindings.find((binding) => binding.name === "test-vault-auth-delegator")
        ?.args.subjects
    ).toEqual([{ kind: "ServiceAccount", name: "vault", namespace: "vault" }]);
    expect(
      createdReleases.find((release) => release.name === "test-vault")?.opts.dependsOn
    ).toContain(
      createdClusterRoleBindings.find((binding) => binding.name === "test-vault-auth-delegator")
        ?.resource
    );
  });

  it("reconciles configured Vault userpass users without exposing passwords", () => {
    const privatePassword = "must-not-appear-in-bootstrap";
    createPlatformStack("test", {
      cluster: makeCluster("test"),
      domain: "reyem.tech",
      certManager: { enabled: false },
      vault: {
        enabled: true,
        secretMount: "kv-prod",
        userpassUsers: [
          {
            username: "mariomeyer",
            password: privatePassword,
            policies: ["default", "read-all-secrets"],
          },
        ],
      },
    });

    const bootstrap = createdConfigMaps.find(
      (resource) => resource.name === "test-vault-bootstrap-script"
    );
    if (!bootstrap) throw new Error("Vault bootstrap ConfigMap was not created");
    const script = bootstrap.args.data["bootstrap.sh"] as string;
    expect(script).toContain("auth/userpass/users/mariomeyer");
    expect(script).toContain("vault policy write read-all-secrets");
    expect(script).toContain('token_policies="default,read-all-secrets"');
    expect(script).toContain('path "kv-prod/data/*" { capabilities = ["read"] }');
    expect(script).toContain('path "kv-prod/metadata/*" { capabilities = ["list", "read"] }');
    expect(script).toContain("password=@/vault/userpass/0/password");
    expect(script).not.toContain(privatePassword);

    const secret = createdSecrets.find((resource) =>
      resource.args.metadata.name.startsWith("test-vault-userpass-")
    );
    if (!secret) throw new Error("Vault userpass Secret was not created");
    expect(secret.args.stringData.password).toEqual({ __secret: privatePassword });

    const vaultValues = createdReleases.find((release) => release.name === "test-vault")?.args
      .values as {
      server: {
        volumes: Array<{ name: string; secret?: { secretName: string } }>;
        extraContainers: Array<{ volumeMounts: Array<{ name: string; mountPath: string }> }>;
      };
    };
    expect(vaultValues.server.volumes).toContainEqual({
      name: "userpass-0",
      secret: { secretName: secret.args.metadata.name },
    });
    expect(vaultValues.server.extraContainers[0]?.volumeMounts).toContainEqual({
      name: "userpass-0",
      mountPath: "/vault/userpass/0",
      readOnly: true,
    });
    expect(script).toContain('path "kv-prod/data/*" { capabilities = ["read"] }');
    expect(script).toContain('path "kv-prod/metadata" { capabilities = ["list", "read"] }');
    expect(script).toContain('path "kv-prod/metadata/*" { capabilities = ["list", "read"] }');
    const readAllPolicy = script.match(
      /vault policy write read-all-secrets - <<'EOPOLICY'\n([\s\S]*?)\nEOPOLICY/
    )?.[1];
    expect(readAllPolicy).toBeDefined();
    expect(readAllPolicy).not.toMatch(/create|update|delete/);
    expect(script).toContain("sleep 300");
    expect(script).toContain("vault token revoke -self >/dev/null 2>&1");
  });

  it("validates userpass usernames and requires explicit non-root policies", () => {
    const base = {
      cluster: makeCluster("test"),
      domain: "reyem.tech",
      certManager: { enabled: false },
      vault: { enabled: true },
    };
    expect(() =>
      createPlatformStack("test", {
        ...base,
        vault: {
          enabled: true,
          userpassUsers: [{ username: "-admin", password: "x", policies: ["default"] }],
        },
      })
    ).toThrow(/Invalid Vault userpass username/);
    expect(() =>
      createPlatformStack("test", {
        ...base,
        vault: {
          enabled: true,
          userpassUsers: [{ username: "admin", password: "x", policies: ["root"] }],
        },
      })
    ).toThrow(/invalid or reserved policy/);
    expect(() =>
      createPlatformStack("test", {
        ...base,
        vault: {
          enabled: true,
          userpassUsers: [{ username: "admin", password: "x", policies: [] }],
        },
      })
    ).toThrow(/must specify at least one policy/);
  });

  it("rejects unsafe KV-v2 mount paths and userpass without bootstrap", () => {
    const base = {
      cluster: makeCluster("test"),
      domain: "reyem.tech",
      certManager: { enabled: false },
    };
    expect(() =>
      createPlatformStack("test", {
        ...base,
        vault: { enabled: true, secretMount: "../secrets" },
      })
    ).toThrow(/Invalid Vault KV-v2 mount/);
    expect(() =>
      createPlatformStack("test", {
        ...base,
        vault: {
          enabled: true,
          bootstrap: false,
          userpassUsers: [{ username: "admin", password: "x", policies: ["default"] }],
        },
      })
    ).toThrow(/userpassUsers require the Vault bootstrap sidecar/);
  });

  it("rejects custom Vault ServiceAccounts that could strand bootstrap authentication", () => {
    expect(() =>
      createPlatformStack("test", {
        cluster: makeCluster("test"),
        domain: "reyem.tech",
        certManager: { enabled: false },
        vault: {
          enabled: true,
          esoSecretPaths: ["argocd/ghcr-reyemtech"],
          values: { server: { serviceAccount: { name: "vault-server" } } },
        },
      })
    ).toThrow(/Vault server ServiceAccount name is fixed to "vault"/);
  });

  it("requires explicit Vault paths when ESO is enabled", () => {
    expect(() =>
      createPlatformStack("test", {
        cluster: makeCluster("test"),
        domain: "reyem.tech",
        certManager: { enabled: false },
        vault: { enabled: true },
        externalSecrets: { enabled: true },
      })
    ).toThrow(/esoSecretPaths/);
  });

  it("rejects Vault ESO paths that could escape the generated policy", () => {
    expect(() =>
      createPlatformStack("test", {
        cluster: makeCluster("test"),
        domain: "reyem.tech",
        certManager: { enabled: false },
        vault: { enabled: true, esoSecretPaths: ['argocd/ghcr" } { capabilities = ["read"] }'] },
        externalSecrets: { enabled: true },
      })
    ).toThrow(/Invalid Vault ESO path/);
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
