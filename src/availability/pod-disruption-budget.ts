/** Policy for voluntary disruption protection on a managed workload. */
export interface IPodDisruptionBudgetConfig {
  enabled?: boolean;
  minAvailable?: number | string;
  maxUnavailable?: number | string;
}

/** Replica count and pod placement preferences for supported workloads. */
export interface IPodSchedulingConfig {
  replicas?: number;
  spread?: {
    strategy?: "pod-anti-affinity" | "topology-spread";
    topologyKey?: string;
    mode?: "preferred" | "required";
  };
}

export type ResolvedPodDisruptionBudget =
  | { minAvailable: number | string }
  | { maxUnavailable: number | string };

/** Resolve and validate a PDB budget for the desired replica count. */
export function resolvePodDisruptionBudget(
  config: IPodDisruptionBudgetConfig = {},
  replicas: number,
): ResolvedPodDisruptionBudget | undefined {
  if (!Number.isInteger(replicas) || replicas < 1) {
    throw new Error("Pod disruption budget replicas must be a positive integer");
  }
  if (config.enabled === false) return undefined;
  if (config.minAvailable !== undefined && config.maxUnavailable !== undefined) {
    throw new Error("Specify only one of minAvailable or maxUnavailable");
  }

  const value = config.minAvailable ?? config.maxUnavailable;
  if (value !== undefined) {
    if (typeof value === "number") {
      if (!Number.isInteger(value) || value < 0) throw new Error("PDB values must be nonnegative integers or percentages");
    } else if (!/^\d+%$/.test(value)) {
      throw new Error("PDB percentage values must be a nonnegative integer followed by %");
    }
  }

  if (config.minAvailable !== undefined) return { minAvailable: config.minAvailable };
  if (config.maxUnavailable !== undefined) return { maxUnavailable: config.maxUnavailable };
  return replicas === 1 ? { minAvailable: 1 } : { maxUnavailable: 1 };
}

/** Build the Kubernetes policy/v1 PDB manifest for a workload selector. */
export function buildPodDisruptionBudgetSpec(
  config: IPodDisruptionBudgetConfig,
  selector: Record<string, string>,
  replicas: number,
) {
  const budget = resolvePodDisruptionBudget(config, replicas);
  if (!budget) return undefined;
  return {
    apiVersion: "policy/v1" as const,
    kind: "PodDisruptionBudget" as const,
    spec: { ...budget, selector: { matchLabels: selector } },
  };
}
