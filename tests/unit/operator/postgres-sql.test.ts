import { describe, it, expect } from "vitest";
import {
  quoteIdentifier,
  normalizePrivilege,
  compileGrantSql,
} from "../../../src/operator/grants/postgres-sql.js";
import { AnyCloudError, ERROR_CODES } from "../../../src/types/errors.js";

describe("quoteIdentifier", () => {
  it("wraps a plain identifier in double quotes", () => {
    expect(quoteIdentifier("marts")).toBe('"marts"');
  });

  it("escapes embedded double quotes by doubling them", () => {
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });

  it("preserves hyphens and mixed case without mangling", () => {
    expect(quoteIdentifier("App-Reader")).toBe('"App-Reader"');
  });

  it("neutralises an injection attempt", () => {
    expect(quoteIdentifier('x"; DROP DATABASE prod; --')).toBe('"x""; DROP DATABASE prod; --"');
  });
});

describe("normalizePrivilege", () => {
  it("uppercases a known privilege", () => {
    expect(normalizePrivilege("select")).toBe("SELECT");
  });

  it("accepts multi-word ALL PRIVILEGES", () => {
    expect(normalizePrivilege("all privileges")).toBe("ALL PRIVILEGES");
  });

  it("rejects an unknown keyword rather than emitting it", () => {
    expect(() => normalizePrivilege("DROP DATABASE")).toThrow(/unsupported privilege/i);
  });

  it("throws an AnyCloudError with code UNSUPPORTED_PRIVILEGE", () => {
    expect.assertions(2);
    try {
      normalizePrivilege("DROP DATABASE");
    } catch (error) {
      expect(error).toBeInstanceOf(AnyCloudError);
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_PRIVILEGE);
    }
  });
});

describe("compileGrantSql", () => {
  it("wraps everything in a single transaction", () => {
    const sql = compileGrantSql({ role: "reader", owner: "etl", grants: [] });
    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("revokes existing privileges before granting", () => {
    const sql = compileGrantSql({
      role: "reader",
      owner: "etl",
      grants: [{ privileges: ["SELECT"], schema: "marts", objects: "all" }],
    });
    expect(sql.indexOf("REVOKE")).toBeLessThan(sql.indexOf("GRANT SELECT"));
  });

  it("emits ALL TABLES plus ALTER DEFAULT PRIVILEGES for objects: all", () => {
    const sql = compileGrantSql({
      role: "reader",
      owner: "etl",
      grants: [{ privileges: ["SELECT"], schema: "marts", objects: "all" }],
    });
    expect(sql).toContain('GRANT USAGE ON SCHEMA "marts" TO "reader";');
    expect(sql).toContain('GRANT SELECT ON ALL TABLES IN SCHEMA "marts" TO "reader";');
    expect(sql).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "etl" IN SCHEMA "marts" GRANT SELECT ON TABLES TO "reader";'
    );
  });

  it("defaults objects to all when omitted", () => {
    const sql = compileGrantSql({
      role: "reader",
      owner: "etl",
      grants: [{ privileges: ["SELECT"], schema: "marts" }],
    });
    expect(sql).toContain("ON ALL TABLES IN SCHEMA");
  });

  it("targets a single table when objects names one", () => {
    const sql = compileGrantSql({
      role: "reader",
      owner: "etl",
      grants: [{ privileges: ["SELECT"], schema: "marts", objects: "orders" }],
    });
    expect(sql).toContain('GRANT SELECT ON "marts"."orders" TO "reader";');
    // The DO-block revoke preamble always mentions "ALL TABLES" and
    // "ALTER DEFAULT PRIVILEGES"; what matters is that no *grant* statement
    // for this schema targets all tables or sets a default privilege.
    expect(sql).not.toContain('GRANT SELECT ON ALL TABLES IN SCHEMA "marts"');
    expect(sql).not.toContain('ALTER DEFAULT PRIVILEGES FOR ROLE "etl" IN SCHEMA "marts" GRANT');
  });

  it("joins multiple privileges in one statement", () => {
    const sql = compileGrantSql({
      role: "app",
      owner: "etl",
      grants: [{ privileges: ["SELECT", "INSERT"], schema: "public", objects: "all" }],
    });
    expect(sql).toContain('GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA "public" TO "app";');
  });

  it("emits statements for every schema in a multi-entry grant list", () => {
    const sql = compileGrantSql({
      role: "reader",
      owner: "etl",
      grants: [
        { privileges: ["SELECT"], schema: "marts", objects: "all" },
        { privileges: ["SELECT"], schema: "staging", objects: "all" },
      ],
    });
    expect(sql).toContain('IN SCHEMA "marts"');
    expect(sql).toContain('IN SCHEMA "staging"');
  });

  it("appends extra SQL after the grants", () => {
    const sql = compileGrantSql({
      role: "reader",
      owner: "etl",
      grants: [{ privileges: ["SELECT"], schema: "marts", objects: "all" }],
      extraSql: ["CREATE EXTENSION IF NOT EXISTS pg_trgm;"],
    });
    expect(sql.indexOf("CREATE EXTENSION")).toBeGreaterThan(sql.indexOf("GRANT SELECT"));
  });

  it("quotes a role name containing a quote", () => {
    const sql = compileGrantSql({
      role: 'ro"le',
      owner: "etl",
      grants: [{ privileges: ["SELECT"], schema: "s", objects: "all" }],
    });
    expect(sql).toContain('TO "ro""le";');
  });

  it("defaults the grant schema to public when omitted", () => {
    const sql = compileGrantSql({
      role: "reader",
      owner: "etl",
      grants: [{ privileges: ["SELECT"] }],
    });
    expect(sql).toContain('IN SCHEMA "public"');
  });

  it("emits a single-backslash pg_ namespace filter, not a double-escaped one", () => {
    const sql = compileGrantSql({ role: "reader", owner: "etl", grants: [] });
    expect(sql).toContain("nspname NOT LIKE 'pg\\_%'");
    expect(sql).not.toContain("pg\\\\_%");
  });

  it("excludes system schemas from the runtime revoke scan", () => {
    const sql = compileGrantSql({ role: "reader", owner: "etl", grants: [] });
    expect(sql).toContain("AND nspname <> 'information_schema'");
  });
});
