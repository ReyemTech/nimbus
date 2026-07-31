import { describe, it, expect } from "vitest";
import {
  assertValidDatabaseName,
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

  it("defaults namespaces to an empty array", () => {
    expect(resolveRoleConfig().namespaces).toEqual([]);
  });

  // `grants` is the one field that must NOT be defaulted. Resolving an omitted
  // `grants` to `[]` would make "nimbus does not manage this role's privileges"
  // indistinguishable from "this role should hold no privileges", and the
  // engines act on that difference: the second revokes, the first does nothing.
  it("leaves an omitted grants list undefined rather than defaulting it", () => {
    expect(resolveRoleConfig().grants).toBeUndefined();
    expect(resolveRoleConfig({ namespaces: ["apps"] }).grants).toBeUndefined();
  });

  it("preserves an explicitly empty grants list", () => {
    expect(resolveRoleConfig({ grants: [] }).grants).toEqual([]);
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

  // An empty account name is not creatable on any of the three engines, and a
  // whitespace-only one narrows to nothing — so every resource would be named
  // after a bare hash. Accepted, all three backends registered a full set of
  // resources and the deploy failed inside the controller or provisioning Job,
  // after `pulumi up` had reported success.
  it.each([
    ["the empty string", ""],
    ["a single space", " "],
    ["a tab", "\t"],
    ["whitespace only", "   \n "],
  ])("rejects %s", (_label, roleName) => {
    expect(() => assertValidRoleName(roleName, "analytics")).toThrow(AnyCloudError);
    expect(() => assertValidRoleName(roleName, "analytics")).toThrow(/is empty/);
  });

  it("reports UNSUPPORTED_ROLE_OPTION for an empty name", () => {
    try {
      assertValidRoleName("", "analytics");
      expect.unreachable("assertValidRoleName should have thrown for an empty name");
    } catch (error) {
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_ROLE_OPTION);
      expect((error as AnyCloudError).message).toContain('"analytics"');
    }
  });

  it.each(["reader", "read_only", "etl-writer", "Read.Only", "grafana@db", "użytkownik"])(
    "accepts %s",
    (roleName) => {
      expect(() => assertValidRoleName(roleName, "analytics")).not.toThrow();
    }
  );

  // A name that is merely padded still names a real account, so it is trimmed
  // by neither the validator nor the engines — only a wholly blank one throws.
  it("accepts a name with surrounding whitespace around real characters", () => {
    expect(() => assertValidRoleName(" reader ", "analytics")).not.toThrow();
  });
});

// The same hole one level up: a database whose name resolved to an empty string
// reached the backends and had every CR, Job and Secret registered for it before
// anything noticed. On CloudNativePG and Neo4j the owner defaults to the
// database name and would have been caught by assertValidRoleName — but only
// while no explicit `owner` was configured.
describe("assertValidDatabaseName", () => {
  it.each([
    ["the empty string", ""],
    ["a single space", " "],
    ["whitespace only", "\t\n"],
  ])("rejects %s", (_label, databaseName) => {
    expect(() => assertValidDatabaseName(databaseName)).toThrow(AnyCloudError);
    expect(() => assertValidDatabaseName(databaseName)).toThrow(/is empty/);
  });

  it("reports UNSUPPORTED_ROLE_OPTION for an empty name", () => {
    try {
      assertValidDatabaseName("");
      expect.unreachable("assertValidDatabaseName should have thrown for an empty name");
    } catch (error) {
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_ROLE_OPTION);
    }
  });

  it.each(["analytics", "billing-prod", "An_Alytics"])("accepts %s", (databaseName) => {
    expect(() => assertValidDatabaseName(databaseName)).not.toThrow();
  });
});
