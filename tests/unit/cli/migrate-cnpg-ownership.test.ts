import { describe, expect, it } from "vitest";
import {
  DATABASE_OWNERSHIP_JSON_QUERY,
  DATABASE_OWNERSHIP_QUERY,
  parseDatabaseRows,
} from "../../../src/cli/migrate-cnpg-ownership.js";

/** Render rows the way `psql -tAc` renders the JSON-wrapped query's single cell. */
const psqlJson = (rows: ReadonlyArray<unknown>): string => `${JSON.stringify(rows)}\n`;

describe("DATABASE_OWNERSHIP_JSON_QUERY", () => {
  it("wraps the documented query verbatim", () => {
    expect(DATABASE_OWNERSHIP_JSON_QUERY).toContain(DATABASE_OWNERSHIP_QUERY);
    expect(DATABASE_OWNERSHIP_JSON_QUERY).toContain("json_agg(row_to_json(");
  });

  // `row_to_json` names each column, so the owner column needs an alias to be
  // readable — `pg_get_userbyid` would otherwise be the key.
  it("names the owner column", () => {
    expect(DATABASE_OWNERSHIP_QUERY).toContain("AS owner");
  });
});

describe("parseDatabaseRows", () => {
  it("parses a well-formed row", () => {
    const { databases, warnings } = parseDatabaseRows(
      psqlJson([{ datname: "analytics", owner: "analytics" }])
    );

    expect(warnings).toEqual([]);
    expect(databases).toEqual([{ name: "analytics", owner: "analytics" }]);
  });

  // The same defect as in the role parser: `psql -tAc` writes an unescaped `|`
  // between columns, so a database or owner name containing one split into three
  // fields where two were expected and the row was dropped — from the check
  // whose job is to notice exactly that database's ownership.
  it("parses a database and owner containing the psql field delimiter", () => {
    const { databases, warnings } = parseDatabaseRows(
      psqlJson([{ datname: "ana|lytics", owner: "et|l" }])
    );

    expect(warnings).toEqual([]);
    expect(databases).toEqual([{ name: "ana|lytics", owner: "et|l" }]);
  });

  it("keeps an ownership mismatch whose names contain a delimiter", () => {
    const { databases } = parseDatabaseRows(
      psqlJson([{ datname: "ana|lytics", owner: "postgres" }])
    );

    expect(databases[0]?.name).not.toBe(databases[0]?.owner);
  });

  it("returns nothing for an empty result set", () => {
    expect(parseDatabaseRows(psqlJson([]))).toEqual({ databases: [], warnings: [] });
  });

  describe("unreadable input", () => {
    it("warns, naming the database, when the owner is missing", () => {
      const { databases, warnings } = parseDatabaseRows(psqlJson([{ datname: "analytics" }]));

      expect(databases).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('database "analytics"');
      expect(warnings[0]).toContain("owner");
      expect(warnings[0]).toContain("NOT checked");
    });

    it("warns, naming the row's position, when the database name is missing", () => {
      const { warnings } = parseDatabaseRows(psqlJson([{ owner: "etl" }]));

      expect(warnings[0]).toContain("pg_database row 1");
      expect(warnings[0]).toContain("datname");
    });

    it("warns but keeps the rows it could read", () => {
      const { databases, warnings } = parseDatabaseRows(
        psqlJson([{ datname: "analytics", owner: "analytics" }, { datname: "billing" }])
      );

      expect(databases.map((database) => database.name)).toEqual(["analytics"]);
      expect(warnings).toHaveLength(1);
    });

    it("warns when the output is not JSON at all", () => {
      const { databases, warnings } = parseDatabaseRows("analytics|analytics\n");

      expect(databases).toEqual([]);
      expect(warnings[0]).toContain("could not parse");
    });
  });
});
