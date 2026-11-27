import type { IPodSchedulingConfig } from "../../availability";

type Spread = NonNullable<IPodSchedulingConfig["spread"]>;

/** Translate typed pod placement for one chart workload and reject competing raw values. */
export function chartPodPlacement(
  spread: Spread | undefined,
  selector: Record<string, string>,
  rawValues: Record<string, unknown>,
  component: string
): Record<string, unknown> {
  if (!spread) return {};

  const rawAffinity = record(rawValues.affinity);
  if (rawValues.affinity !== undefined || rawValues.topologySpreadConstraints !== undefined) {
    throw new Error(`${component} scheduling.spread conflicts with Helm pod spread values`);
  }

  const topologyKey = spread.topologyKey ?? "kubernetes.io/hostname";
  const term = {
    topologyKey,
    labelSelector: { matchLabels: selector },
  };
  if (spread.strategy === "pod-anti-affinity") {
    return {
      affinity: {
        ...rawAffinity,
        podAntiAffinity:
          spread.mode === "required"
            ? {
                requiredDuringSchedulingIgnoredDuringExecution: [
                  { ...term, matchLabelKeys: ["app.kubernetes.io/instance"] },
                ],
              }
            : {
                preferredDuringSchedulingIgnoredDuringExecution: [
                  {
                    podAffinityTerm: { ...term, matchLabelKeys: ["app.kubernetes.io/instance"] },
                    weight: 100,
                  },
                ],
              },
      },
    };
  }

  return {
    topologySpreadConstraints: [
      {
        ...term,
        maxSkew: 1,
        whenUnsatisfiable: spread.mode === "required" ? "DoNotSchedule" : "ScheduleAnyway",
      },
    ],
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
