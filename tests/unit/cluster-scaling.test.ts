import { describe, expect, it } from "vitest";
import type { IClusterConfig } from "../../src/cluster";
import { validateEksNodePoolScaling } from "../../src/aws/eks-autoscaling";
import { validateUnsupportedPoolScaling } from "../../src/cluster/scaling";

const legacyPool = { name: "steady", instanceType: "m7i.large", minNodes: 1, maxNodes: 4 } as const;

const base = {
  cloud: "aws",
  nodePools: [legacyPool],
} satisfies IClusterConfig;

describe("EKS node pool scaling validation", () => {
  it("accepts legacy and fixed managed pools", () => {
    expect(() => validateEksNodePoolScaling(base, {})).not.toThrow();
    expect(() =>
      validateEksNodePoolScaling(
        { ...base, nodePools: [{ ...legacyPool, name: "batch_workers" }] },
        {}
      )
    ).not.toThrow();
    expect(() =>
      validateEksNodePoolScaling(
        {
          ...base,
          nodePools: [{ ...legacyPool, scaling: { mode: "fixed" } }],
        },
        {}
      )
    ).not.toThrow();
  });

  it("requires a stable managed pool for Cluster Autoscaler", () => {
    const config = {
      ...base,
      nodePools: [{ ...legacyPool, scaling: { mode: "cluster-autoscaler" } }],
    } satisfies IClusterConfig;
    expect(() => validateEksNodePoolScaling(config, {})).toThrow(
      /autoscalerControllerNodePoolName/
    );
    expect(() =>
      validateEksNodePoolScaling(config, { autoscalerControllerNodePoolName: "steady" })
    ).not.toThrow();
  });

  it("rejects invalid Karpenter and mixed ownership selections", () => {
    const karpenter = {
      ...base,
      nodePools: [{ name: "burst", scaling: { mode: "karpenter", instanceTypes: [] } }],
    } as unknown as IClusterConfig;
    expect(() => validateEksNodePoolScaling(karpenter, {})).toThrow(/at least one instance type/);

    const mixed = {
      ...base,
      nodePools: [
        legacyPool,
        { name: "burst", scaling: { mode: "karpenter", instanceTypes: ["m7i.large"] } },
      ],
    } satisfies IClusterConfig;
    expect(() =>
      validateEksNodePoolScaling(mixed, {
        autoscalerControllerNodePoolName: "steady",
        autoMode: true,
      })
    ).toThrow(/Auto Mode/);
    expect(() =>
      validateEksNodePoolScaling(
        {
          ...base,
          nodePools: [
            legacyPool,
            { name: "burst", scaling: { mode: "karpenter", instanceTypes: ["m7i.large"] } },
          ],
        },
        { autoscalerControllerNodePoolName: "steady", authenticationMode: "CONFIG_MAP" }
      )
    ).toThrow(/API authentication/);
  });

  it("requires a stable on-demand pool for controller placement", () => {
    const config = {
      ...base,
      nodePools: [{ ...legacyPool, spot: true, scaling: { mode: "cluster-autoscaler" } }],
    } satisfies IClusterConfig;
    expect(() =>
      validateEksNodePoolScaling(config, { autoscalerControllerNodePoolName: "steady" })
    ).toThrow(/on-demand/);
  });

  it("rejects a fixed controller pool whose effective desired count is zero", () => {
    const config = {
      ...base,
      nodePools: [
        { ...legacyPool, desiredNodes: 0, scaling: { mode: "fixed" } },
        { name: "burst", scaling: { mode: "karpenter", instanceTypes: ["m7i.large"] } },
      ],
    } satisfies IClusterConfig;
    expect(() =>
      validateEksNodePoolScaling(config, { autoscalerControllerNodePoolName: "steady" })
    ).toThrow(/autoscalerControllerNodePoolName/);
  });

  it("rejects duplicate names and reserved label collisions", () => {
    expect(() =>
      validateEksNodePoolScaling(
        {
          ...base,
          nodePools: [legacyPool, { ...legacyPool }],
        },
        {}
      )
    ).toThrow(/Duplicate/);
    expect(() =>
      validateEksNodePoolScaling(
        {
          ...base,
          nodePools: [
            {
              ...legacyPool,
              scaling: { mode: "cluster-autoscaler" },
              labels: { "nimbus.dev/node-pool": "other" },
            },
          ],
        },
        { autoscalerControllerNodePoolName: "steady" }
      )
    ).toThrow(/reserved/);
  });

  it("rejects EKS-only autoscalers on other providers", () => {
    const karpenter = {
      cloud: "azure",
      nodePools: [{ name: "burst", scaling: { mode: "karpenter", instanceTypes: ["m7i.large"] } }],
    } as unknown as IClusterConfig;
    expect(() => validateUnsupportedPoolScaling("Azure AKS", karpenter)).toThrow(/only on AWS EKS/);
  });
});
