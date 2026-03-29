import { describe, it, expect } from "vitest";
import { resolveStorageTier, type StorageTierMap } from "../../src/types/storage-tiers";

describe("resolveStorageTier", () => {
  const tierMap: StorageTierMap = {
    standard: "sata",
    performance: "ssd",
    "high-performance": "ssd-large",
  };

  it("resolves a named tier to its storage class", () => {
    expect(resolveStorageTier("performance", tierMap)).toBe("ssd");
  });

  it("resolves standard tier", () => {
    expect(resolveStorageTier("standard", tierMap)).toBe("sata");
  });

  it("resolves high-performance tier", () => {
    expect(resolveStorageTier("high-performance", tierMap)).toBe("ssd-large");
  });

  it("returns undefined when tierMap is undefined", () => {
    expect(resolveStorageTier("performance", undefined)).toBeUndefined();
  });

  it("returns undefined when tier is undefined", () => {
    expect(resolveStorageTier(undefined, tierMap)).toBeUndefined();
  });
});
