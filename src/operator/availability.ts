/** Availability mappings verified against the database operator charts and CRDs. */
import type * as k8s from "@pulumi/kubernetes";
import {
  resolvePodDisruptionBudget,
  type IPodSchedulingConfig,
  type ResolvedPodDisruptionBudget,
} from "../availability";
import type { IOperatorConfig, OperatorType } from "./interfaces";

export const HOSTNAME_TOPOLOGY_KEY = "kubernetes.io/hostname";
const NAME_LABEL = "app.kubernetes.io/name";
export const INSTANCE_LABEL = "app.kubernetes.io/instance";
const MARIADB_HA_REPLICAS = 3;

type ControllerType = Exclude<OperatorType, "neo4j">;
type PodSpread = NonNullable<IPodSchedulingConfig["spread"]>;

const CONTROLLER_CHARTS = {
  "cloudnative-pg": { selectorName: "cloudnative-pg", replicas: 1 },
  "mariadb-operator": { selectorName: "mariadb-operator", replicas: 1 },
  minio: { selectorName: "operator", replicas: 2 },
} as const;

interface IControllerAvailability {
  readonly values: Record<string, unknown>;
  readonly selectorName: string;
  readonly namespace: string;
  readonly standaloneBudget?: ResolvedPodDisruptionBudget;
}

type PodPlacement =
  | { affinity: { podAntiAffinity: k8s.types.input.core.v1.PodAntiAffinity } }
  | { topologySpreadConstraints: k8s.types.input.core.v1.TopologySpreadConstraint[] };

/** Build pod placement for a workload whose pods carry the supplied labels. */
export function buildPodPlacement(
  spread: PodSpread,
  matchLabels: Record<string, string>,
  matchLabelKeys?: string[]
): PodPlacement {
  const topologyKey = spread.topologyKey ?? HOSTNAME_TOPOLOGY_KEY;
  const required = spread.mode === "required";
  const selector = {
    topologyKey,
    labelSelector: { matchLabels },
    ...(matchLabelKeys && { matchLabelKeys }),
  };

  if (spread.strategy === "topology-spread") {
    return {
      topologySpreadConstraints: [
        {
          ...selector,
          maxSkew: 1,
          whenUnsatisfiable: required ? "DoNotSchedule" : "ScheduleAnyway",
        },
      ],
    };
  }

  return {
    affinity: {
      podAntiAffinity: required
        ? { requiredDuringSchedulingIgnoredDuringExecution: [selector] }
        : {
            preferredDuringSchedulingIgnoredDuringExecution: [
              { podAffinityTerm: selector, weight: 100 },
            ],
          },
    },
  };
}

export function helmMap(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function validateReplicaOverride(typed: number | undefined, raw: unknown, path: string): void {
  if (typed !== undefined && raw !== undefined && raw !== typed) {
    throw new Error(`scheduling.replicas conflicts with Helm values.${path}`);
  }
}

function chartReplicaCount(value: unknown, defaultCount: number): number {
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return typeof value === "number" ? value : defaultCount;
}

function controllerPlacement(
  type: ControllerType,
  spread: PodSpread | undefined,
  values: Record<string, unknown>,
  selectorName: string
): Record<string, unknown> {
  if (!spread) return {};

  const rawAffinity = helmMap(values.affinity);
  if (rawAffinity.podAntiAffinity !== undefined || values.topologySpreadConstraints !== undefined) {
    throw new Error(`${type} scheduling.spread conflicts with Helm pod spread values`);
  }
  const placement = buildPodPlacement(spread, { [NAME_LABEL]: selectorName }, [INSTANCE_LABEL]);
  const minio = type === "minio";

  if ("topologySpreadConstraints" in placement) {
    return {
      ...placement,
      // Clear MinIO's built-in required anti-affinity when the caller selects a different strategy.
      ...(minio && { affinity: { ...rawAffinity, podAntiAffinity: null } }),
    };
  }

  return {
    affinity: {
      ...rawAffinity,
      podAntiAffinity: {
        // Helm merges maps. Clear the opposite chart default when switching to preferred.
        ...(minio &&
          spread.mode !== "required" && { requiredDuringSchedulingIgnoredDuringExecution: null }),
        ...placement.affinity.podAntiAffinity,
      },
    },
  };
}

/** Resolve each controller's verified Helm paths, default replica count and PDB ownership. */
export function controllerAvailability(
  type: ControllerType,
  config: IOperatorConfig,
  namespace: string
): IControllerAvailability {
  const values = { ...config.values };
  const chart = CONTROLLER_CHARTS[type];
  const typedReplicas = config.scheduling?.replicas;
  const override =
    type !== "minio" && typeof values.nameOverride === "string" && values.nameOverride;
  const selectorName = override ? override.slice(0, 63).replace(/-$/, "") : chart.selectorName;
  const minio = type === "minio";
  const mariadb = type === "mariadb-operator";
  const controllerValues = minio ? helmMap(values.operator) : values;
  const ha = helmMap(values.ha);

  let rawReplicas: unknown = controllerValues.replicaCount;
  if (mariadb) {
    rawReplicas = ha.enabled === true ? (ha.replicas ?? MARIADB_HA_REPLICAS) : undefined;
    validateReplicaOverride(typedReplicas, ha.replicas, "ha.replicas");
    if (
      typedReplicas !== undefined &&
      ha.enabled !== undefined &&
      ha.enabled !== typedReplicas > 1
    ) {
      throw new Error("scheduling.replicas conflicts with Helm values.ha.enabled");
    }
  } else {
    validateReplicaOverride(
      typedReplicas,
      rawReplicas,
      minio ? "operator.replicaCount" : "replicaCount"
    );
  }

  const replicas = typedReplicas ?? chartReplicaCount(rawReplicas, chart.replicas);
  const budget = resolvePodDisruptionBudget(config.podDisruptionBudget, replicas);
  const placement = controllerPlacement(
    type,
    config.scheduling?.spread,
    controllerValues,
    selectorName
  );
  const replicaValue = typedReplicas === undefined ? {} : { replicaCount: typedReplicas };

  let standaloneBudget = budget;
  if (minio) {
    if (typedReplicas !== undefined || config.scheduling?.spread) {
      values.operator = { ...controllerValues, ...replicaValue, ...placement };
    }
  } else if (mariadb) {
    Object.assign(values, placement);
    if (typedReplicas !== undefined) {
      values.ha = { ...ha, enabled: typedReplicas > 1, replicas: typedReplicas };
    }
    if (values.pdb !== undefined) {
      if (config.podDisruptionBudget !== undefined) {
        throw new Error("podDisruptionBudget conflicts with Helm values.pdb");
      }
      // A low-level chart override already declares the PDB policy.
      standaloneBudget = undefined;
    } else if (budget && "maxUnavailable" in budget) {
      values.pdb = { enabled: true, maxUnavailable: budget.maxUnavailable };
      standaloneBudget = undefined;
    } else {
      // This chart's native PDB only supports maxUnavailable.
      values.pdb = { enabled: false };
    }
  } else {
    Object.assign(values, replicaValue, placement);
  }

  return {
    values,
    selectorName,
    namespace:
      type === "cloudnative-pg" &&
      typeof values.namespaceOverride === "string" &&
      values.namespaceOverride
        ? values.namespaceOverride
        : namespace,
    standaloneBudget,
  };
}
