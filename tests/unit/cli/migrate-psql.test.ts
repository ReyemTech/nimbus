import { describe, expect, it } from "vitest";
import {
  parseJsonRows,
  readBoolean,
  readNullableString,
  readNumber,
  readString,
  readStringArray,
  toJsonRowsQuery,
} from "../../../src/cli/migrate-psql.js";

describe("toJsonRowsQuery", () => {
  it("embeds the query verbatim as a subquery", () => {
    const query = "SELECT datname FROM pg_database ORDER BY 1";

    expect(toJsonRowsQuery(query)).toContain(`(${query})`);
  });

  // Without coalesce, json_agg over an empty result returns SQL NULL, which
  // psql prints as the empty string — indistinguishable from a failed query.
  it("renders an empty result as a valid empty document", () => {
    expect(toJsonRowsQuery("SELECT 1")).toContain("coalesce(");
    expect(toJsonRowsQuery("SELECT 1")).toContain("'[]'::json");
  });
});

describe("parseJsonRows", () => {
  it("returns each object row in order", () => {
    const { rows, warnings } = parseJsonRows('[{"a":1},{"a":2}]', "pg_roles");

    expect(warnings).toEqual([]);
    expect(rows).toEqual([{ a: 1 }, { a: 2 }]);
  });

  // json_agg puts a newline between elements, and psql prints the value as-is.
  it("parses output json_agg has split across lines", () => {
    const { rows } = parseJsonRows('[{"a":1}, \n {"a":2}]\n', "pg_roles");

    expect(rows).toHaveLength(2);
  });

  it("parses a value containing the psql field delimiter", () => {
    const { rows, warnings } = parseJsonRows('[{"rolname":"read|er"}]', "pg_roles");

    expect(warnings).toEqual([]);
    expect(rows[0]?.["rolname"]).toBe("read|er");
  });

  it("returns nothing for an empty result set", () => {
    expect(parseJsonRows("[]\n", "pg_roles")).toEqual({ rows: [], warnings: [] });
  });

  it("warns, naming the subject, when the output is empty", () => {
    const { rows, warnings } = parseJsonRows("  \n", "pg_roles");

    expect(rows).toEqual([]);
    expect(warnings[0]).toContain("pg_roles");
    expect(warnings[0]).toContain("no output");
  });

  it("warns when the output is not JSON", () => {
    const { warnings } = parseJsonRows("analytics|t|f\n", "pg_roles");

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("could not parse");
    expect(warnings[0]).toContain("analytics|t|f");
  });

  it("warns when the document is not a list of rows", () => {
    const { rows, warnings } = parseJsonRows('{"rolname":"analytics"}', "pg_roles");

    expect(rows).toEqual([]);
    expect(warnings[0]).toContain("not a list of rows");
  });

  // An element that is not an object is a row this parser cannot read, and a
  // dropped row is worse than a reported one: the caller would report a clean
  // check over a set that silently shrank.
  it("warns per unusable element, keeping the usable ones", () => {
    const { rows, warnings } = parseJsonRows('[{"a":1},null,"x",[1]]', "pg_roles");

    expect(rows).toEqual([{ a: 1 }]);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain("pg_roles row 2");
  });

  it("truncates a long unparseable payload in the warning", () => {
    const { warnings } = parseJsonRows("x".repeat(500), "pg_roles");

    expect(warnings[0]?.length).toBeLessThan(400);
    expect(warnings[0]).toContain("…");
  });
});

describe("column readers", () => {
  const row: Record<string, unknown> = {
    name: "analytics",
    empty: "",
    flag: false,
    limit: -1,
    notFinite: Number.POSITIVE_INFINITY,
    members: ["a", "b"],
    mixed: ["a", 1],
    psqlBoolean: "t",
    nothing: null,
  };

  it("reads a non-empty string", () => {
    expect(readString(row, "name")).toBe("analytics");
    expect(readString(row, "empty")).toBeUndefined();
    expect(readString(row, "missing")).toBeUndefined();
    expect(readString(row, "flag")).toBeUndefined();
  });

  // psql's `t`/`f` is a string, not a boolean: reading it as one would silently
  // treat every attribute as false.
  it("reads only a JSON boolean", () => {
    expect(readBoolean(row, "flag")).toBe(false);
    expect(readBoolean(row, "psqlBoolean")).toBeUndefined();
    expect(readBoolean(row, "missing")).toBeUndefined();
  });

  it("reads only a finite number", () => {
    expect(readNumber(row, "limit")).toBe(-1);
    expect(readNumber(row, "notFinite")).toBeUndefined();
    expect(readNumber(row, "name")).toBeUndefined();
  });

  // A SQL NULL in a nullable column is data — `rolvaliduntil` NULL is how
  // PostgreSQL says a password never expires — so it must be distinguishable
  // from a column that could not be read, which warns and drops the whole role.
  it("keeps a SQL NULL apart from an unreadable column", () => {
    expect(readNullableString(row, "nothing")).toBeNull();
    expect(readNullableString(row, "missing")).toBeUndefined();
    expect(readNullableString(row, "flag")).toBeUndefined();
    expect(readNullableString(row, "name")).toBe("analytics");
  });

  // `COMMENT ON ROLE … IS ''` is a real state; unlike readString, an empty
  // string here is a value rather than "could not read this".
  it("reads an empty string as a value", () => {
    expect(readNullableString(row, "empty")).toBe("");
  });

  it("reads only an array of strings", () => {
    expect(readStringArray(row, "members")).toEqual(["a", "b"]);
    expect(readStringArray(row, "mixed")).toBeUndefined();
    expect(readStringArray(row, "name")).toBeUndefined();
  });
});
