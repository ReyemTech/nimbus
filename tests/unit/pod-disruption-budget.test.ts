import { describe, expect, it } from "vitest";
import { buildPodDisruptionBudgetSpec, resolvePodDisruptionBudget } from "../../src/availability";

describe("pod disruption budget policy", () => {
  it("defaults to one protected pod for one replica and one unavailable for multiple replicas", () => {
    expect(resolvePodDisruptionBudget({}, 1)).toEqual({ minAvailable: 1 });
    expect(resolvePodDisruptionBudget({}, 2)).toEqual({ maxUnavailable: 1 });
  });

  it("preserves explicit integer and percentage values", () => {
    expect(resolvePodDisruptionBudget({ minAvailable: 2 }, 3)).toEqual({ minAvailable: 2 });
    expect(resolvePodDisruptionBudget({ maxUnavailable: "25%" }, 4)).toEqual({ maxUnavailable: "25%" });
  });

  it("returns undefined when disabled", () => {
    expect(resolvePodDisruptionBudget({ enabled: false }, 1)).toBeUndefined();
  });

  it.each([
    [{ minAvailable: 1, maxUnavailable: 1 }, 2],
    [{ minAvailable: -1 }, 2],
    [{ maxUnavailable: "nope%" }, 2],
    [{ minAvailable: 1.5 }, 2],
    [{}, 0],
  ])("rejects invalid policy %j for %i replicas", (config, replicas) => {
    expect(() => resolvePodDisruptionBudget(config, replicas)).toThrow();
  });

  it("builds a policy/v1 PDB spec with the supplied selector", () => {
    expect(buildPodDisruptionBudgetSpec({ maxUnavailable: 1 }, { app: "demo" }, 2)).toEqual({
      apiVersion: "policy/v1",
      kind: "PodDisruptionBudget",
      spec: { maxUnavailable: 1, selector: { matchLabels: { app: "demo" } } },
    });
  });
});
