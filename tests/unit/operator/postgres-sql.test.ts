import { describe, it, expect } from "vitest";
import {
  quoteIdentifier,
  normalizePrivilege,
  compileGrantSql,
} from "../../../src/operator/grants/postgres-sql.js";
import { AnyCloudError, ERROR_CODES } from "../../../src/types/errors.js";

/** One `REVOKE` the preamble emits: the privileges it strips, and from what. */
interface IRevokedTarget {
  /** Privilege list as written, e.g. `"ALL"` or `"USAGE, SELECT"`. */
  readonly privileges: string;
  /** Object class the privileges are stripped from, e.g. `"ALL SEQUENCES IN SCHEMA %I"`. */
  readonly target: string;
}

/**
 * Collect every `REVOKE <privileges> ON <target>` the compiled script contains.
 *
 * The preamble builds its statements with `format()`, so the targets come back
 * with `%I` placeholders still in them — which is what makes them comparable
 * against a fixed expected set regardless of role or schema names.
 */
function revokedTargets(sql: string): IRevokedTarget[] {
  const pattern =
    /REVOKE ([A-Z][A-Z, ]*?) ON ((?:ALL \w+ IN SCHEMA %I)|(?:SCHEMA %I)|(?:\w+)) FROM/g;
  return [...sql.matchAll(pattern)].map((match) => ({
    privileges: match[1] as string,
    target: match[2] as string,
  }));
}

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
  //
  // USAGE and CREATE are the same class and were briefly allowed by mistake:
  // they are schema privileges, so with `objects` defaulting to "all" they
  // rendered as `GRANT USAGE ON ALL TABLES IN SCHEMA ...`, which PostgreSQL
  // rejects with "invalid privilege type USAGE for relation".
  it.each(["EXECUTE", "CONNECT", "TEMPORARY", "USAGE", "CREATE"])(
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

  // A write grant is useless on a table with a serial/identity column unless
  // the column's owning sequence is usable: nextval() checks the sequence's own
  // ACL, so INSERT alone fails with "permission denied for sequence".
  it("grants sequence USAGE, SELECT alongside an INSERT grant", () => {
    const sql = compileGrantSql({
      role: "app",
      owner: "etl",
      grants: [{ privileges: ["SELECT", "INSERT"], schema: "marts", objects: "all" }],
    });

    expect(sql).toContain('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "marts" TO "app";');
    expect(sql).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "etl" IN SCHEMA "marts" ' +
        'GRANT USAGE, SELECT ON SEQUENCES TO "app";'
    );
  });

  it.each(["UPDATE", "ALL PRIVILEGES"])("grants sequences for a %s grant too", (privilege) => {
    const sql = compileGrantSql({
      role: "app",
      owner: "etl",
      grants: [{ privileges: [privilege], schema: "marts" }],
    });

    expect(sql).toContain('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "marts" TO "app";');
  });

  // A read-only role has no use for a sequence and must not be silently widened.
  it.each(["SELECT", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"])(
    "grants no sequence privileges for a %s-only grant",
    (privilege) => {
      const sql = compileGrantSql({
        role: "reader",
        owner: "etl",
        grants: [{ privileges: [privilege], schema: "marts" }],
      });

      expect(sql).not.toContain("GRANT USAGE, SELECT ON ALL SEQUENCES");
    }
  );

  it("grants a schema's sequences once even for several write grants in it", () => {
    const sql = compileGrantSql({
      role: "app",
      owner: "etl",
      grants: [
        { privileges: ["INSERT"], schema: "marts", objects: "orders" },
        { privileges: ["UPDATE"], schema: "marts", objects: "invoices" },
      ],
    });

    const occurrences = sql.split('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "marts"').length;
    expect(occurrences - 1).toBe(1);
  });

  // The invariant that makes reconciliation safe: convergence works by revoking
  // everything first, so a privilege the preamble strips but no grant spec can
  // ask back is lost permanently the first time any grant is reconciled. This
  // pins the revoked set to exactly the privileges the grant path can restore —
  // adding a REVOKE without a matching GRANT fails here.
  it("never revokes a privilege the grant path cannot restore", () => {
    // A maximal spec: every privilege the API accepts, on every object.
    const sql = compileGrantSql({
      role: "app",
      owner: "etl",
      grants: [{ privileges: ["ALL PRIVILEGES"], schema: "public", objects: "all" }],
    });

    expect(revokedTargets(sql)).toEqual([
      { privileges: "ALL", target: "ALL TABLES IN SCHEMA %I" },
      { privileges: "USAGE, SELECT", target: "ALL SEQUENCES IN SCHEMA %I" },
      { privileges: "USAGE", target: "SCHEMA %I" },
      { privileges: "ALL", target: "TABLES" },
      { privileges: "USAGE, SELECT", target: "SEQUENCES" },
    ]);

    // revokedTargets() only recognises three target shapes. Pin the count of
    // *every* REVOKE keyword in the script to the count it found, so a REVOKE
    // shape the helper's regex cannot parse (e.g. `ON DATABASE ...` or
    // `ON FUNCTION ...`) fails this test by going uncounted here, rather than
    // silently passing the invariant check above unseen.
    const revokeKeywordCount = (sql.match(/REVOKE\b/g) ?? []).length;
    expect(revokeKeywordCount).toBe(revokedTargets(sql).length);

    // ...and each of those five is put back by the maximal spec.
    expect(sql).toContain('GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA "public" TO "app";');
    expect(sql).toContain('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "app";');
    expect(sql).toContain('GRANT USAGE ON SCHEMA "public" TO "app";');
    expect(sql).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "etl" IN SCHEMA "public" ' +
        'GRANT ALL PRIVILEGES ON TABLES TO "app";'
    );
    expect(sql).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "etl" IN SCHEMA "public" ' +
        'GRANT USAGE, SELECT ON SEQUENCES TO "app";'
    );
  });

  // Schema CREATE and sequence UPDATE (setval) are the two privileges no grant
  // spec can express, so the preamble deliberately leaves them alone rather
  // than stripping access nothing can hand back.
  it("leaves schema CREATE and sequence UPDATE untouched", () => {
    const sql = compileGrantSql({ role: "reader", owner: "etl", grants: [] });

    expect(sql).not.toContain("REVOKE ALL ON SCHEMA");
    expect(sql).not.toContain("REVOKE ALL ON ALL SEQUENCES");
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
