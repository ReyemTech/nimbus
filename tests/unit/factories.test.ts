/**
 * Unit tests for factory dispatch logic.
 *
 * Tests the factory functions' routing, CIDR auto-offset, network matching,
 * and error handling without requiring cloud provider SDKs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { INetwork } from "../../src/network";
import type { ICluster } from "../../src/cluster";
import type { IDns } from "../../src/dns";
import type { ISecrets } from "../../src/secrets";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockOutput = (val: unknown): any => val;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockResource = (): any => ({});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockProvider = (): any => ({});

function makeNetwork(name: string, provider: "aws" | "azure"): INetwork {
  return {
    name,
    cloud: { provider, region: provider === "aws" ? "us-east-1" : "eastus" },
    vpcId: mockOutput(`vpc-${provider}-mock`),
    cidr: provider === "aws" ? "10.0.0.0/16" : "10.1.0.0/16",
    publicSubnetIds: mockOutput([]),
    privateSubnetIds: mockOutput([]),
    nativeResource: mockResource(),
  };
}

function makeCluster(name: string, provider: "aws" | "azure" | "rackspace"): ICluster {
  const regionMap = { aws: "us-east-1", azure: "eastus", rackspace: "us-east-iad-1" };
  return {
    name,
    cloud: { provider, region: regionMap[provider] },
    endpoint: mockOutput(`https://${provider}-mock`),
    kubeconfig: mockOutput("{}"),
    version: mockOutput("1.32"),
    nodePools: [],
    nativeResource: mockResource(),
    provider: mockProvider(),
  };
}

function makeDns(name: string, provider: "aws" | "azure"): IDns {
  return {
    name,
    cloud: { provider, region: provider === "aws" ? "us-east-1" : "eastus" },
    zoneId: mockOutput(`zone-${provider}`),
    zoneName: "example.com",
    nameServers: mockOutput([]),
    addRecord: vi.fn(),
    nativeResource: mockResource(),
  };
}

function makeSecrets(name: string, provider: "aws" | "azure"): ISecrets {
  return {
    name,
    cloud: { provider, region: provider === "aws" ? "us-east-1" : "eastus" },
    backend: provider === "aws" ? ("aws-secrets-manager" as const) : ("azure-key-vault" as const),
    putSecret: vi.fn(),
    getSecretRef: vi.fn(),
    nativeResource: mockResource(),
  };
}

// Mock cloud-specific implementations
vi.mock("../../src/aws", () => ({
  createAwsNetwork: vi.fn((name: string) => makeNetwork(name, "aws")),
  createEksCluster: vi.fn((name: string) => makeCluster(name, "aws")),
  createRoute53Dns: vi.fn((name: string) => makeDns(name, "aws")),
  createAwsSecrets: vi.fn((name: string) => makeSecrets(name, "aws")),
}));

vi.mock("../../src/azure", () => ({
  createAzureNetwork: vi.fn((name: string) => makeNetwork(name, "azure")),
  createAksCluster: vi.fn((name: string) => makeCluster(name, "azure")),
  createAzureDns: vi.fn((name: string) => makeDns(name, "azure")),
  createAzureSecrets: vi.fn((name: string) => makeSecrets(name, "azure")),
}));

vi.mock("../../src/rackspace", () => ({
  createRackspaceSpotCluster: vi.fn((name: string) => makeCluster(name, "rackspace")),
}));

import { createNetwork } from "../../src/factories/network";
import { createCluster } from "../../src/factories/cluster";
import { createDns } from "../../src/factories/dns";
import { createSecrets } from "../../src/factories/secrets";
import { extractProvider, isMultiCloud } from "../../src/factories/types";
import {
  createAwsNetwork,
  createEksCluster,
  createRoute53Dns,
  createAwsSecrets,
} from "../../src/aws";
import {
  createAzureNetwork,
  createAksCluster,
  createAzureDns,
  createAzureSecrets,
} from "../../src/azure";
import { createRackspaceSpotCluster } from "../../src/rackspace";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("factory types", () => {
  describe("extractProvider", () => {
    it("extracts provider from string", () => {
      expect(extractProvider("aws")).toBe("aws");
      expect(extractProvider("azure")).toBe("azure");
    });

    it("extracts provider from CloudTarget", () => {
      expect(extractProvider({ provider: "aws", region: "us-west-2" })).toBe("aws");
      expect(extractProvider({ provider: "azure" })).toBe("azure");
    });
  });

  describe("isMultiCloud", () => {
    it("returns false for single string", () => {
      expect(isMultiCloud("aws")).toBe(false);
    });

    it("returns false for single CloudTarget", () => {
      expect(isMultiCloud({ provider: "aws" })).toBe(false);
    });

    it("returns true for array", () => {
      expect(isMultiCloud(["aws", "azure"])).toBe(true);
    });

    it("returns true for array of CloudTargets", () => {
      expect(isMultiCloud([{ provider: "aws" }, { provider: "azure" }])).toBe(true);
    });
  });
});

describe("createNetwork factory", () => {
  it("dispatches to AWS for cloud: 'aws'", async () => {
    const result = await createNetwork("prod", {
      cloud: "aws",
      cidr: "10.0.0.0/16",
      natStrategy: "fck-nat",
    });

    expect(createAwsNetwork).toHaveBeenCalledTimes(1);
    expect(createAzureNetwork).not.toHaveBeenCalled();
    expect(Array.isArray(result)).toBe(false);
    expect((result as INetwork).name).toBe("prod");
  });

  it("dispatches to Azure for cloud: 'azure' with providerOptions", async () => {
    const result = await createNetwork("prod", {
      cloud: "azure",
      cidr: "10.1.0.0/16",
      providerOptions: { azure: { resourceGroupName: "my-rg" } },
    });

    expect(createAzureNetwork).toHaveBeenCalledTimes(1);
    expect(createAwsNetwork).not.toHaveBeenCalled();
    expect(Array.isArray(result)).toBe(false);
  });

  it("throws when Azure is targeted without providerOptions", () => {
    expect(() =>
      createNetwork("prod", {
        cloud: "azure",
        cidr: "10.1.0.0/16",
      })
    ).toThrow("Azure requires providerOptions.azure.resourceGroupName");
  });

  it("returns array for multi-cloud", async () => {
    const result = await createNetwork("prod", {
      cloud: ["aws", "azure"],
      cidr: "10.0.0.0/16",
      providerOptions: { azure: { resourceGroupName: "my-rg" } },
    });

    expect(Array.isArray(result)).toBe(true);
    expect((result as INetwork[]).length).toBe(2);
    expect(createAwsNetwork).toHaveBeenCalledTimes(1);
    expect(createAzureNetwork).toHaveBeenCalledTimes(1);
  });

  it("auto-offsets CIDRs for multi-cloud", async () => {
    await createNetwork("prod", {
      cloud: ["aws", "azure"],
      cidr: "10.0.0.0/16",
      providerOptions: { azure: { resourceGroupName: "my-rg" } },
    });

    // AWS should get 10.0.0.0/16, Azure should get 10.1.0.0/16
    const awsCall = vi.mocked(createAwsNetwork).mock.calls[0];
    const azureCall = vi.mocked(createAzureNetwork).mock.calls[0];
    expect(awsCall?.[1]?.cidr).toBe("10.0.0.0/16");
    expect(azureCall?.[1]?.cidr).toBe("10.1.0.0/16");
  });

  it("passes AWS options through providerOptions", async () => {
    await createNetwork("prod", {
      cloud: "aws",
      cidr: "10.0.0.0/16",
      natStrategy: "fck-nat",
      providerOptions: {
        aws: { fckNatInstanceType: "t4g.micro", availabilityZoneCount: 3 },
      },
    });

    const awsOpts = vi.mocked(createAwsNetwork).mock.calls[0]?.[2];
    expect(awsOpts).toEqual({
      fckNatInstanceType: "t4g.micro",
      availabilityZoneCount: 3,
    });
  });

  it("throws for unsupported provider", () => {
    expect(() =>
      createNetwork("prod", {
        cloud: "gcp" as "aws",
        cidr: "10.0.0.0/16",
      })
    ).toThrow("network");
  });

  it("uses CloudTarget with explicit region", async () => {
    await createNetwork("prod", {
      cloud: { provider: "aws", region: "eu-west-1" },
      cidr: "10.0.0.0/16",
    });

    const config = vi.mocked(createAwsNetwork).mock.calls[0]?.[1];
    expect(config?.cloud).toEqual({ provider: "aws", region: "eu-west-1" });
  });
});

describe("createCluster factory", () => {
  const nodePools = [{ name: "system", instanceType: "t4g.small", minNodes: 2, maxNodes: 3 }];

  const awsNetwork = makeNetwork("prod", "aws");
  const azureNetwork = makeNetwork("prod", "azure");

  it("dispatches to EKS for cloud: 'aws'", async () => {
    await createCluster("prod", { cloud: "aws", nodePools }, awsNetwork);

    expect(createEksCluster).toHaveBeenCalledTimes(1);
    expect(createAksCluster).not.toHaveBeenCalled();
  });

  it("dispatches to AKS for cloud: 'azure'", async () => {
    await createCluster(
      "prod",
      {
        cloud: "azure",
        nodePools,
        providerOptions: { azure: { resourceGroupName: "my-rg" } },
      },
      azureNetwork
    );

    expect(createAksCluster).toHaveBeenCalledTimes(1);
    expect(createEksCluster).not.toHaveBeenCalled();
  });

  it("passes AWS options through providerOptions", async () => {
    await createCluster(
      "prod",
      {
        cloud: "aws",
        nodePools,
        providerOptions: { aws: { autoMode: true, endpointAccess: "private" } },
      },
      awsNetwork
    );

    const eksOpts = vi.mocked(createEksCluster).mock.calls[0]?.[3];
    expect(eksOpts).toEqual({
      autoMode: true,
      endpointAccess: "private",
    });
  });

  it("returns array for multi-cloud and matches networks by provider", async () => {
    const result = await createCluster(
      "prod",
      {
        cloud: ["aws", "azure"],
        nodePools,
        providerOptions: { azure: { resourceGroupName: "my-rg" } },
      },
      [awsNetwork, azureNetwork]
    );

    expect(Array.isArray(result)).toBe(true);
    expect((result as ICluster[]).length).toBe(2);
    expect(createEksCluster).toHaveBeenCalledTimes(1);
    expect(createAksCluster).toHaveBeenCalledTimes(1);
  });

  it("throws when no matching network found", () => {
    expect(() =>
      createCluster(
        "prod",
        {
          cloud: ["aws", "azure"],
          nodePools,
          providerOptions: { azure: { resourceGroupName: "my-rg" } },
        },
        [awsNetwork] // missing azure network
      )
    ).toThrow('No network found for provider "azure"');
  });

  it("throws when Azure is targeted without providerOptions", () => {
    expect(() => createCluster("prod", { cloud: "azure", nodePools }, azureNetwork)).toThrow(
      "Azure requires providerOptions.azure.resourceGroupName"
    );
  });

  it("accepts single network for single cloud", async () => {
    await createCluster("prod", { cloud: "aws", nodePools }, awsNetwork);

    expect(createEksCluster).toHaveBeenCalledTimes(1);
    const passedNetwork = vi.mocked(createEksCluster).mock.calls[0]?.[2];
    expect(passedNetwork).toBe(awsNetwork);
  });
});

describe("createDns factory", () => {
  it("dispatches to Route53 for cloud: 'aws'", async () => {
    const result = await createDns("prod", {
      cloud: "aws",
      zoneName: "example.com",
    });

    expect(createRoute53Dns).toHaveBeenCalledTimes(1);
    expect(createAzureDns).not.toHaveBeenCalled();
    expect(Array.isArray(result)).toBe(false);
  });

  it("dispatches to Azure DNS for cloud: 'azure'", async () => {
    await createDns("prod", {
      cloud: "azure",
      zoneName: "example.com",
      providerOptions: { azure: { resourceGroupName: "my-rg" } },
    });

    expect(createAzureDns).toHaveBeenCalledTimes(1);
    expect(createRoute53Dns).not.toHaveBeenCalled();
  });

  it("throws for Azure without providerOptions", () => {
    expect(() =>
      createDns("prod", {
        cloud: "azure",
        zoneName: "example.com",
      })
    ).toThrow("Azure requires providerOptions.azure.resourceGroupName");
  });

  it("returns array for multi-cloud", async () => {
    const result = await createDns("prod", {
      cloud: ["aws", "azure"],
      zoneName: "example.com",
      providerOptions: { azure: { resourceGroupName: "my-rg" } },
    });

    expect(Array.isArray(result)).toBe(true);
    expect((result as IDns[]).length).toBe(2);
  });
});

describe("createSecrets factory", () => {
  it("dispatches to AWS Secrets Manager for cloud: 'aws'", async () => {
    const result = await createSecrets("prod", {
      cloud: "aws",
      backend: "aws-secrets-manager",
    });

    expect(createAwsSecrets).toHaveBeenCalledTimes(1);
    expect(createAzureSecrets).not.toHaveBeenCalled();
    expect(Array.isArray(result)).toBe(false);
  });

  it("dispatches to Azure Key Vault for cloud: 'azure'", async () => {
    await createSecrets("prod", {
      cloud: "azure",
      backend: "azure-key-vault",
      providerOptions: {
        azure: { resourceGroupName: "my-rg" },
      },
    });

    expect(createAzureSecrets).toHaveBeenCalledTimes(1);
    expect(createAwsSecrets).not.toHaveBeenCalled();
  });

  it("dispatches to Azure Key Vault with optional tenantId", async () => {
    await createSecrets("prod", {
      cloud: "azure",
      backend: "azure-key-vault",
      providerOptions: {
        azure: { resourceGroupName: "my-rg", tenantId: "tenant-123" },
      },
    });

    expect(createAzureSecrets).toHaveBeenCalledTimes(1);
  });

  it("throws for Azure without providerOptions", () => {
    expect(() =>
      createSecrets("prod", {
        cloud: "azure",
        backend: "azure-key-vault",
      })
    ).toThrow("Azure requires providerOptions.azure with resourceGroupName");
  });

  it("returns array for multi-cloud", async () => {
    const result = await createSecrets("prod", {
      cloud: ["aws", "azure"],
      providerOptions: {
        azure: { resourceGroupName: "my-rg" },
      },
    });

    expect(Array.isArray(result)).toBe(true);
    expect((result as ISecrets[]).length).toBe(2);
  });
});

describe("multi-cloud naming", () => {
  it("prefixes resource names with provider for multi-cloud", async () => {
    await createNetwork("prod", {
      cloud: ["aws", "azure"],
      cidr: "10.0.0.0/16",
      providerOptions: { azure: { resourceGroupName: "my-rg" } },
    });

    expect(vi.mocked(createAwsNetwork).mock.calls[0]?.[0]).toBe("prod-aws");
    expect(vi.mocked(createAzureNetwork).mock.calls[0]?.[0]).toBe("prod-azure");
  });

  it("uses original name for single-cloud", async () => {
    await createNetwork("prod", {
      cloud: "aws",
      cidr: "10.0.0.0/16",
    });

    expect(vi.mocked(createAwsNetwork).mock.calls[0]?.[0]).toBe("prod");
  });
});

describe("rackspace dispatch", () => {
  it("dispatches to createRackspaceSpotCluster for cloud: rackspace", () => {
    const result = createCluster("test-rs", {
      cloud: { provider: "rackspace", region: "us-east-iad-1" },
      nodePools: [
        {
          name: "workers",
          instanceType: "gp.vs1.xlarge-iad",
          minNodes: 3,
          maxNodes: 3,
          spot: true,
          bidPrice: 0.04,
        },
      ],
      providerOptions: {
        rackspace: { cloudspaceName: "my-cloudspace" },
      },
    });

    expect(createRackspaceSpotCluster).toHaveBeenCalledOnce();
    expect(result).toBeDefined();
    expect((result as ICluster).cloud.provider).toBe("rackspace");
  });

  it("throws when rackspace options are missing", () => {
    expect(() =>
      createCluster("test-rs", {
        cloud: "rackspace",
        nodePools: [],
      })
    ).toThrow(/providerOptions.rackspace/);
  });

  it("does not require a network parameter for rackspace", () => {
    const result = createCluster("test-rs", {
      cloud: "rackspace",
      nodePools: [],
      providerOptions: { rackspace: { cloudspaceName: "test" } },
    });

    expect(result).toBeDefined();
  });

  it("still requires network for aws", () => {
    expect(() =>
      createCluster("test-aws", {
        cloud: "aws",
        nodePools: [],
      })
    ).toThrow(/require a network/);
  });
});
