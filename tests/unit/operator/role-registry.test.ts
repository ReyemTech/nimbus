import { describe, expect, it } from "vitest";
import { createRoleRegistry } from "../../../src/operator/role-registry.js";
import { AnyCloudError, ERROR_CODES } from "../../../src/types/errors.js";

/** A registry with recognisable wording, so the message assertions mean something. */
function makeRegistry(clusterName = "pgsql-main"): ReturnType<typeof createRoleRegistry> {
  return createRoleRegistry({
    clusterName,
    scopeNoun: "cluster",
    scopeExplanation: "PostgreSQL roles are cluster-global.",
  });
}

describe("createRoleRegistry", () => {
  it("accepts distinct identities", () => {
    const registry = makeRegistry();

    expect(() => {
      registry.claim({ identity: "reader", label: '"reader"', databaseName: "billing" });
      registry.claim({ identity: "writer", label: '"writer"', databaseName: "billing" });
      registry.claim({ identity: "etl", label: '"etl"', databaseName: "analytics" });
    }).not.toThrow();
  });

  it("rejects an identity claimed by another database, naming both", () => {
    const registry = makeRegistry();
    registry.claim({ identity: "reader", label: '"reader"', databaseName: "billing" });

    try {
      registry.claim({ identity: "reader", label: '"reader"', databaseName: "analytics" });
      expect.unreachable("the second claim should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(AnyCloudError);
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_ROLE_OPTION);
      const { message } = error as AnyCloudError;
      expect(message).toContain('"reader"');
      expect(message).toContain('"billing"');
      expect(message).toContain('"analytics"');
      expect(message).toContain('cluster "pgsql-main"');
      expect(message).toContain("PostgreSQL roles are cluster-global.");
    }
  });

  it("rejects an identity claimed twice by the same database", () => {
    const registry = makeRegistry();
    registry.claim({ identity: "reader", label: '"reader"', databaseName: "billing" });

    expect(() =>
      registry.claim({ identity: "reader", label: '"reader"', databaseName: "billing" })
    ).toThrow(/already claimed by database "billing"/);
  });

  // The identity is the dedupe key and the label is only display, so two roles
  // that differ in identity must both be allowed even when they render alike —
  // this is what keeps MariaDB's `reader`@`%` and `reader`@`10.0.0.1` distinct.
  it("keys on identity, not on the label", () => {
    const registry = makeRegistry();

    expect(() => {
      registry.claim({ identity: "reader@%", label: '"reader"', databaseName: "billing" });
      registry.claim({ identity: "reader@10.0.0.1", label: '"reader"', databaseName: "billing" });
    }).not.toThrow();
  });

  it("keeps separate registries independent", () => {
    const a = makeRegistry("pg-a");
    const b = makeRegistry("pg-b");

    expect(() => {
      a.claim({ identity: "reader", label: '"reader"', databaseName: "billing" });
      b.claim({ identity: "reader", label: '"reader"', databaseName: "billing" });
    }).not.toThrow();
  });
});
