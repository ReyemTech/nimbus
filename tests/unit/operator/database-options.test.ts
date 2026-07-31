import { describe, expect, it } from "vitest";
import {
  ENGINE_NAMES,
  assertNoForeignEngineOptions,
} from "../../../src/operator/database-options.js";
import type { IDatabaseRoleConfig } from "../../../src/operator/interfaces.js";
import { AnyCloudError, ERROR_CODES } from "../../../src/types/errors.js";

/** Shorthand for the `engineOptions` shape under test. */
type EngineOptions = IDatabaseRoleConfig["engineOptions"];

/** Every field of the `postgresql` block, so presence is not the only thing set. */
const POSTGRES_BLOCK: EngineOptions = {
  postgresql: { inRoles: ["pg_read_all_data"], connectionLimit: 5, validUntil: "2030-01-01" },
};

/** Every field of the `mariadb` block. */
const MARIADB_BLOCK: EngineOptions = { mariadb: { host: "10.0.0.1", maxUserConnections: 5 } };

describe("assertNoForeignEngineOptions", () => {
  it("accepts the block the engine honours", () => {
    expect(() =>
      assertNoForeignEngineOptions({
        roleName: "reader",
        databaseName: "billing",
        engineOptions: POSTGRES_BLOCK,
        honoured: "postgresql",
        engine: ENGINE_NAMES.CNPG,
      })
    ).not.toThrow();
  });

  it("accepts a config with no engineOptions at all", () => {
    expect(() =>
      assertNoForeignEngineOptions({
        roleName: "reader",
        databaseName: "billing",
        honoured: "postgresql",
        engine: ENGINE_NAMES.CNPG,
      })
    ).not.toThrow();
  });

  // The block would provision successfully with its host and connection cap
  // simply absent — the silent drop every other unhonourable option is refused
  // for, and more misleading here because the caller named an engine and a
  // different one accepted it.
  it("rejects another engine's block", () => {
    expect(() =>
      assertNoForeignEngineOptions({
        roleName: "reader",
        databaseName: "billing",
        engineOptions: MARIADB_BLOCK,
        honoured: "postgresql",
        engine: ENGINE_NAMES.CNPG,
      })
    ).toThrow(AnyCloudError);
  });

  it("names the offending block, the engine, and the engine that honours it", () => {
    try {
      assertNoForeignEngineOptions({
        roleName: "reader",
        databaseName: "billing",
        engineOptions: MARIADB_BLOCK,
        honoured: "postgresql",
        engine: ENGINE_NAMES.CNPG,
      });
      expect.unreachable("a foreign engineOptions block should have been rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(AnyCloudError);
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_ROLE_OPTION);
      expect((error as AnyCloudError).message).toContain('"engineOptions.mariadb"');
      expect((error as AnyCloudError).message).toContain(ENGINE_NAMES.CNPG);
      expect((error as AnyCloudError).message).toContain(ENGINE_NAMES.MARIADB);
      expect((error as AnyCloudError).message).toContain('"reader"');
      expect((error as AnyCloudError).message).toContain('"billing"');
    }
  });

  // Presence is what makes the config wrong, not content: an empty block still
  // names an engine that will not run this role.
  it("rejects an empty foreign block", () => {
    expect(() =>
      assertNoForeignEngineOptions({
        roleName: "reader",
        databaseName: "billing",
        engineOptions: { mariadb: {} },
        honoured: "postgresql",
        engine: ENGINE_NAMES.CNPG,
      })
    ).toThrow(/engineOptions.mariadb/);
  });

  // Neo4j has no operator and no CRs, and nothing in either block maps onto
  // `CREATE USER`, so it honours none.
  it.each([
    ["postgresql", POSTGRES_BLOCK],
    ["mariadb", MARIADB_BLOCK],
  ])("rejects the %s block on an engine that honours none", (block, engineOptions) => {
    expect(() =>
      assertNoForeignEngineOptions({
        roleName: "reader",
        databaseName: "graph",
        engineOptions,
        engine: ENGINE_NAMES.NEO4J,
      })
    ).toThrow(new RegExp(`engineOptions\\.${block}`));
  });

  it("says the engine honours no block at all when it honours none", () => {
    expect(() =>
      assertNoForeignEngineOptions({
        roleName: "reader",
        databaseName: "graph",
        engineOptions: MARIADB_BLOCK,
        engine: ENGINE_NAMES.NEO4J,
      })
    ).toThrow(/honours no engineOptions block at all/);
  });

  it("accepts an empty engineOptions object, which names no engine", () => {
    expect(() =>
      assertNoForeignEngineOptions({
        roleName: "reader",
        databaseName: "graph",
        engineOptions: {},
        engine: ENGINE_NAMES.NEO4J,
      })
    ).not.toThrow();
  });
});
