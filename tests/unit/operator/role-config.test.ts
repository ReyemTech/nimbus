import { describe, it, expect } from "vitest";
import {
  assertValidRoleName,
  resolveRoleConfig,
} from "../../../src/operator/grants/role-config.js";
import { AnyCloudError, ERROR_CODES } from "../../../src/types/errors.js";

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

// A role name is caller-controlled and flows into generated SQL, into the
// Cypher `CREATE USER` statement Neo4j's provisioning Job runs, and into CR
// spec fields. Every engine quotes identifiers with one of these characters, so
// any of them can terminate the quoting.
describe("assertValidRoleName", () => {
  it.each([
    ["a backtick", "read`er", "a backtick"],
    ["a single quote", "read'er", "a single quote"],
    ["a double quote", 'read"er', "a double quote"],
    ["a backslash", "read\\er", "a backslash"],
    ["a NUL byte", "read\0er", "a NUL byte"],
  ])("rejects a name containing %s", (_label, roleName, expected) => {
    expect(() => assertValidRoleName(roleName, "analytics")).toThrow(AnyCloudError);
    expect(() => assertValidRoleName(roleName, "analytics")).toThrow(expected);
  });

  it("reports UNSUPPORTED_ROLE_OPTION and names the role and the database", () => {
    try {
      assertValidRoleName("read`er", "analytics");
      expect.unreachable("assertValidRoleName should have thrown for a backtick");
    } catch (error) {
      expect(error).toBeInstanceOf(AnyCloudError);
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_ROLE_OPTION);
      expect((error as AnyCloudError).message).toContain("read`er");
      expect((error as AnyCloudError).message).toContain('"analytics"');
    }
  });

  // The Cypher statement is `CREATE USER \`$DB_USER\` ...`, so this is the
  // shape that would close the identifier and append a second statement.
  it("rejects a name that would break out of Cypher identifier quoting", () => {
    expect(() => assertValidRoleName("x` SET PASSWORD 'pwned' //", "graph")).toThrow(AnyCloudError);
  });

  it.each(["reader", "read_only", "etl-writer", "Read.Only", "grafana@db", "użytkownik"])(
    "accepts %s",
    (roleName) => {
      expect(() => assertValidRoleName(roleName, "analytics")).not.toThrow();
    }
  );
});
