import { describe, it, expect } from "vitest";
import { resolveRoleConfig } from "../../../src/operator/grants/role-config.js";

describe("resolveRoleConfig", () => {
  it("defaults login to true", () => {
    const resolved = resolveRoleConfig();
    expect(resolved.login).toBe(true);
  });

  it("defaults reclaimPolicy to retain", () => {
    const resolved = resolveRoleConfig();
    expect(resolved.reclaimPolicy).toBe("retain");
  });

  it("defaults namespaces and grants to empty arrays", () => {
    const resolved = resolveRoleConfig();
    expect(resolved.namespaces).toEqual([]);
    expect(resolved.grants).toEqual([]);
  });

  it("preserves explicit login false", () => {
    expect(resolveRoleConfig({ login: false }).login).toBe(false);
  });

  it("preserves explicit values", () => {
    const resolved = resolveRoleConfig({
      namespaces: ["apps"],
      reclaimPolicy: "delete",
      grants: [{ privileges: ["SELECT"], schema: "marts" }],
    });
    expect(resolved.namespaces).toEqual(["apps"]);
    expect(resolved.reclaimPolicy).toBe("delete");
    expect(resolved.grants).toHaveLength(1);
  });

  it("rejects a grant that lists no privileges", () => {
    expect(() => resolveRoleConfig({ grants: [{ privileges: [] }] })).toThrow(
      /at least one privilege/i
    );
  });
});
