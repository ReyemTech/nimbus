import type { IClusterConfig } from "./interfaces";

/** Reject EKS-only autoscaler selections on providers that cannot honor them. */
export function validateUnsupportedPoolScaling(provider: string, config: IClusterConfig): void {
  const unsupported = config.nodePools.find(
    (pool) => pool.scaling?.mode === "karpenter" || pool.scaling?.mode === "cluster-autoscaler"
  );
  if (unsupported) {
    const mode = unsupported.scaling?.mode;
    throw new Error(
      `Node pool scaling mode "${mode}" is supported only on AWS EKS, not ${provider}.`
    );
  }
}
