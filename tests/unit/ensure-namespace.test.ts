/**
 * Unit tests for ensureNamespace policy injection.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockProvider = (): any => ({});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdNamespaces: Array<{ name: string; args: any }>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdLimitRanges: Array<{ name: string; args: any }>;

vi.mock("@pulumi/kubernetes", () => {
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockNamespace = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdNamespaces.push({ name, args });
    }
  };
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockLimitRange = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdLimitRanges.push({ name, args });
    }
  };
  return {
    core: { v1: { Namespace: mockNamespace, LimitRange: mockLimitRange } },
  };
});

beforeEach(() => {
  createdNamespaces = [];
  createdLimitRanges = [];
  vi.resetModules();
});

describe("ensureNamespace", () => {
  it("creates Namespace + default LimitRange when no policy passed", async () => {
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace.js");
    ensureNamespace("test-ns", mockProvider());
    expect(createdNamespaces).toHaveLength(1);
    expect(createdNamespaces[0]?.args.metadata.name).toBe("test-ns");
    expect(createdLimitRanges).toHaveLength(1);
    expect(createdLimitRanges[0]?.args.metadata.namespace).toBe("test-ns");
    expect(createdLimitRanges[0]?.args.metadata.name).toBe("default-limits");
    const limit = createdLimitRanges[0]?.args.spec.limits[0];
    expect(limit.type).toBe("Container");
    expect(limit.defaultRequest.ephemeralStorage).toBe("500Mi");
    expect(limit.default.ephemeralStorage).toBe("2Gi");
  });

  it("memoizes namespace creation", async () => {
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace.js");
    const provider = mockProvider();
    const ns1 = ensureNamespace("memo-ns", provider);
    const ns2 = ensureNamespace("memo-ns", provider);
    expect(ns1).toBe(ns2);
    expect(createdNamespaces).toHaveLength(1);
  });

  it("creates Namespace only (no LimitRange) when policy is false", async () => {
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace.js");
    ensureNamespace("opt-out-ns", mockProvider(), { policy: false });
    expect(createdNamespaces).toHaveLength(1);
    expect(createdLimitRanges).toHaveLength(0);
  });

  it("creates Namespace only when policy.limitRange is false", async () => {
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace.js");
    ensureNamespace("opt-out-lr", mockProvider(), {
      policy: { limitRange: false },
    });
    expect(createdNamespaces).toHaveLength(1);
    expect(createdLimitRanges).toHaveLength(0);
  });

  it("uses override values when policy.limitRange is provided", async () => {
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace.js");
    ensureNamespace("custom-ns", mockProvider(), {
      policy: {
        limitRange: {
          defaultRequest: { ephemeralStorage: "1Gi" },
          defaultLimit: { ephemeralStorage: "5Gi" },
        },
      },
    });
    const limit = createdLimitRanges[0]?.args.spec.limits[0];
    expect(limit.defaultRequest.ephemeralStorage).toBe("1Gi");
    expect(limit.default.ephemeralStorage).toBe("5Gi");
  });

  it("does NOT create LimitRange for SYSTEM_NAMESPACES even when policy passed", async () => {
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace.js");
    ensureNamespace("kube-system", mockProvider(), {
      policy: {
        limitRange: {
          defaultRequest: { ephemeralStorage: "1Gi" },
          defaultLimit: { ephemeralStorage: "5Gi" },
        },
      },
    });
    expect(createdNamespaces).toHaveLength(1);
    expect(createdLimitRanges).toHaveLength(0);
  });

  it("reads override from nimbus singleton when no opts.policy passed", async () => {
    const { nimbus } = await import("../../src/nimbus/index.js");
    nimbus.configure({
      namespacePolicies: {
        "from-singleton": {
          limitRange: {
            defaultRequest: { ephemeralStorage: "750Mi" },
            defaultLimit: { ephemeralStorage: "3Gi" },
          },
        },
      },
    });
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace.js");
    ensureNamespace("from-singleton", mockProvider());
    const limit = createdLimitRanges[0]?.args.spec.limits[0];
    expect(limit.defaultRequest.ephemeralStorage).toBe("750Mi");
    expect(limit.default.ephemeralStorage).toBe("3Gi");
  });

  it("opts.policy takes precedence over singleton override", async () => {
    const { nimbus } = await import("../../src/nimbus/index.js");
    nimbus.configure({
      namespacePolicies: {
        "precedence-test": {
          limitRange: {
            defaultRequest: { ephemeralStorage: "1Gi" },
            defaultLimit: { ephemeralStorage: "5Gi" },
          },
        },
      },
    });
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace.js");
    ensureNamespace("precedence-test", mockProvider(), {
      policy: {
        limitRange: {
          defaultRequest: { ephemeralStorage: "2Gi" },
          defaultLimit: { ephemeralStorage: "10Gi" },
        },
      },
    });
    const limit = createdLimitRanges[0]?.args.spec.limits[0];
    expect(limit.defaultRequest.ephemeralStorage).toBe("2Gi");
    expect(limit.default.ephemeralStorage).toBe("10Gi");
  });

  it("singleton override of false skips the LimitRange", async () => {
    const { nimbus } = await import("../../src/nimbus/index.js");
    nimbus.configure({
      namespacePolicies: {
        "skip-from-singleton": false,
      },
    });
    const { ensureNamespace } = await import("../../src/utils/ensure-namespace.js");
    ensureNamespace("skip-from-singleton", mockProvider());
    expect(createdNamespaces).toHaveLength(1);
    expect(createdLimitRanges).toHaveLength(0);
  });
});
