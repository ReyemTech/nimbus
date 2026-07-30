import { describe, it, expect } from "vitest";
import {
  quoteIdentifier,
  normalizePrivilege,
  compileGrantSql,
} from "../../../src/operator/grants/postgres-sql.js";
import { AnyCloudError, ERROR_CODES } from "../../../src/types/errors.js";

/** Extract the `$tag$` used to open the compiled script's `DO` block. */
function extractDollarTag(sql: string): string {
  const tag = sql.match(/DO (\$nimbus\d*\$)/)?.[1];
  if (!tag) {
    throw new Error("expected a DO $nimbus...$ block in the compiled SQL");
  }
  return tag;
}

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

  // EXECUTE, CONNECT, and TEMPORARY are real PostgreSQL privileges, but this
  // compiler only ever emits GRANT ... ON ALL TABLES / ON <table> / ON SCHEMA
  // statements, none of which can carry them. Accepting them here would pass
  // validation and then fail (or silently do nothing) when the script runs.
  it.each(["EXECUTE", "CONNECT", "TEMPORARY"])(
    "rejects %s because this compiler has no emission path for it",
    (privilege) => {
      expect(() => normalizePrivilege(privilege)).toThrow(/unsupported privilege/i);
    }
  );
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

  it("scans every non-system schema unconditionally, not gated on has_schema_privilege", () => {
    const sql = compileGrantSql({ role: "reader", owner: "etl", grants: [] });
    expect(sql).not.toContain("has_schema_privilege");
  });

  it("derives a collision-free dollar-quote tag when a role contains $nimbus$", () => {
    const injected = "x$nimbus$; DROP DATABASE prod; --";
    const sql = compileGrantSql({ role: injected, owner: "etl", grants: [] });

    const tag = extractDollarTag(sql);

    // The chosen tag must not be the colliding "$nimbus$" the injected value
    // contains, and it must not appear anywhere inside the injected value —
    // otherwise the DO block would be terminated early by attacker data.
    expect(tag).not.toBe("$nimbus$");
    expect(injected.includes(tag)).toBe(false);

    // Opening and closing delimiters must match, and the tag must occur
    // exactly twice in the whole script (open + close). A third occurrence
    // would mean the tag leaked into — or collided with — embedded data.
    expect(sql).toContain(`END\n${tag};`);
    expect(sql.split(tag).length - 1).toBe(2);

    // The injected payload is present only as inert data inside a quoted
    // string literal (the has_schema_privilege/format argument), never as a
    // standalone top-level statement introduced by an early-terminated block.
    expect(sql).toContain(`, 'x$nimbus$; DROP DATABASE prod; --');`);
  });

  // A role may revoke its own privileges in PostgreSQL, and an owner's rights
  // over its own objects are ordinary ACL entries — so running the revoke
  // preamble against the owner would lock the owner out of its own tables.
  it("omits the revoke preamble when the role is the owner", () => {
    const sql = compileGrantSql({
      role: "app",
      owner: "app",
      grants: [],
      extraSql: ["CREATE EXTENSION IF NOT EXISTS pgcrypto;"],
    });

    expect(sql).not.toContain("REVOKE");
    expect(sql).not.toContain("DO $");
    expect(sql).toBe("BEGIN;\nCREATE EXTENSION IF NOT EXISTS pgcrypto;\nCOMMIT;");
  });

  it("still grants when the role is the owner", () => {
    const sql = compileGrantSql({
      role: "app",
      owner: "app",
      grants: [{ privileges: ["SELECT"], schema: "marts", objects: "all" }],
    });

    expect(sql).not.toContain("REVOKE");
    expect(sql).toContain('GRANT SELECT ON ALL TABLES IN SCHEMA "marts" TO "app";');
  });

  it("still avoids collision when both role and owner contain the base tag", () => {
    const sql = compileGrantSql({
      role: "$nimbus$",
      owner: "$nimbus0$",
      grants: [],
    });
    const tag = extractDollarTag(sql);
    expect(tag).not.toBe("$nimbus$");
    expect(tag).not.toBe("$nimbus0$");
  });
});
