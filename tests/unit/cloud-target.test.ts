import { describe, it, expect } from "vitest";
import {
  isCloudProvider,
  isCloudTarget,
  resolveCloudTarget,
  DEFAULT_REGIONS,
  CLOUD_PROVIDERS,
} from "../../src/types/cloud-target";
import { CloudValidationError } from "../../src/types/errors";

describe("isCloudProvider", () => {
  it("returns true for valid providers", () => {
    expect(isCloudProvider("aws")).toBe(true);
    expect(isCloudProvider("azure")).toBe(true);
    expect(isCloudProvider("gcp")).toBe(true);
    expect(isCloudProvider("rackspace")).toBe(true);
  });

  it("returns false for invalid values", () => {
    expect(isCloudProvider("invalid")).toBe(false);
    expect(isCloudProvider("")).toBe(false);
    expect(isCloudProvider(42)).toBe(false);
    expect(isCloudProvider(null)).toBe(false);
    expect(isCloudProvider(undefined)).toBe(false);
    expect(isCloudProvider({})).toBe(false);
  });
});

describe("isCloudTarget", () => {
  it("returns true for valid CloudTarget objects", () => {
    expect(isCloudTarget({ provider: "aws" })).toBe(true);
    expect(isCloudTarget({ provider: "azure", region: "canadacentral" })).toBe(true);
    expect(isCloudTarget({ provider: "gcp", region: "us-central1" })).toBe(true);
    expect(isCloudTarget({ provider: "rackspace" })).toBe(true);
  });

  it("returns false for invalid values", () => {
    expect(isCloudTarget(null)).toBe(false);
    expect(isCloudTarget(undefined)).toBe(false);
    expect(isCloudTarget("aws")).toBe(false);
    expect(isCloudTarget({})).toBe(false);
    expect(isCloudTarget({ provider: "invalid" })).toBe(false);
    expect(isCloudTarget({ region: "us-east-1" })).toBe(false);
  });
});

describe("resolveCloudTarget", () => {
  it("resolves a provider string to default region", () => {
    const result = resolveCloudTarget("aws");
    expect(result).toEqual({ provider: "aws", region: "us-east-1" });
  });

  it("resolves each provider to its default region", () => {
    for (const provider of CLOUD_PROVIDERS) {
      const result = resolveCloudTarget(provider);
      expect(result).toEqual({
        provider,
        region: DEFAULT_REGIONS[provider],
      });
    }
  });

  it("resolves a CloudTarget with explicit region", () => {
    const result = resolveCloudTarget({ provider: "aws", region: "eu-west-1" });
    expect(result).toEqual({ provider: "aws", region: "eu-west-1" });
  });

  it("resolves a CloudTarget without region to default", () => {
    const result = resolveCloudTarget({ provider: "azure" });
    expect(result).toEqual({ provider: "azure", region: "eastus" });
  });

  it("resolves an array of providers", () => {
    const result = resolveCloudTarget(["aws", "azure"]);
    expect(result).toEqual([
      { provider: "aws", region: "us-east-1" },
      { provider: "azure", region: "eastus" },
    ]);
  });

  it("resolves a mixed array of providers and targets", () => {
    const result = resolveCloudTarget(["aws", { provider: "azure", region: "canadacentral" }]);
    expect(result).toEqual([
      { provider: "aws", region: "us-east-1" },
      { provider: "azure", region: "canadacentral" },
    ]);
  });

  it("throws CloudValidationError for invalid input", () => {
    expect(() => resolveCloudTarget("invalid" as never)).toThrow(CloudValidationError);
    expect(() => resolveCloudTarget("invalid" as never)).toThrow("Invalid cloud argument");
  });
});

describe("DEFAULT_REGIONS", () => {
  it("has an entry for every provider in CLOUD_PROVIDERS", () => {
    for (const provider of CLOUD_PROVIDERS) {
      expect(DEFAULT_REGIONS[provider]).toBeDefined();
      expect(typeof DEFAULT_REGIONS[provider]).toBe("string");
    }
  });

  it("includes rackspace", () => {
    expect(DEFAULT_REGIONS.rackspace).toBe("us-east-iad-1");
  });
});

describe("CLOUD_PROVIDERS", () => {
  it("contains all expected providers", () => {
    expect(CLOUD_PROVIDERS).toContain("aws");
    expect(CLOUD_PROVIDERS).toContain("azure");
    expect(CLOUD_PROVIDERS).toContain("gcp");
    expect(CLOUD_PROVIDERS).toContain("rackspace");
    expect(CLOUD_PROVIDERS).toHaveLength(4);
  });
});
