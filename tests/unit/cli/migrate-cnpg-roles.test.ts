import { describe, expect, it } from "vitest";
import {
  ROLE_ATTRIBUTES_JSON_QUERY,
  ROLE_ATTRIBUTES_QUERY,
  describeRoleDeviation,
  parseRoleRows,
  roleMatchesBaseline,
  type IParsedRoleRow,
} from "../../../src/cli/migrate-cnpg-roles.js";

/** A role sitting exactly on the baseline adoption leaves untouched. */
const baselineRow = (name: string): Record<string, unknown> => ({
  rolname: name,
  rolcanlogin: true,
  rolsuper: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolinherit: true,
  rolconnlimit: -1,
  rolbypassrls: false,
  rolreplication: false,
  rolvaliduntil: null,
  rolcomment: null,
  memberof: [],
});

/** Render rows the way `psql -tAc` renders the JSON-wrapped query's single cell. */
const psqlJson = (rows: ReadonlyArray<unknown>): string => `${JSON.stringify(rows)}\n`;

describe("ROLE_ATTRIBUTES_JSON_QUERY", () => {
  // The documented query is what an operator runs by hand; the wrapper only
  // changes how the result is rendered. Embedding it verbatim is what keeps the
  // two from drifting apart.
  it("wraps the documented query verbatim", () => {
    expect(ROLE_ATTRIBUTES_JSON_QUERY).toContain(ROLE_ATTRIBUTES_QUERY);
    expect(ROLE_ATTRIBUTES_JSON_QUERY).toContain("json_agg(row_to_json(");
  });

  // Adoption resets every attribute the manifest omits, so an attribute the
  // query does not select is one the check cannot see being reset.
  it.each([
    "rolcanlogin",
    "rolsuper",
    "rolcreatedb",
    "rolcreaterole",
    "rolinherit",
    "rolconnlimit",
    "rolbypassrls",
    "rolreplication",
    "rolvaliduntil",
    "rolcomment",
    "memberof",
  ])("selects %s, which DatabaseRole.spec can reset", (column) => {
    expect(ROLE_ATTRIBUTES_QUERY).toContain(column);
  });
});

describe("parseRoleRows", () => {
  it("parses a well-formed row", () => {
    const { roles, warnings } = parseRoleRows(psqlJson([baselineRow("analytics")]));

    expect(warnings).toEqual([]);
    expect(roles).toEqual([
      {
        name: "analytics",
        canLogin: true,
        isSuperuser: false,
        canCreateDb: false,
        canCreateRole: false,
        inherits: true,
        connectionLimit: -1,
        bypassesRls: false,
        canReplicate: false,
        validUntil: null,
        comment: null,
        memberOf: [],
      },
    ]);
  });

  // `rolvaliduntil` and `rolcomment` are nullable: a SQL NULL is the baseline
  // value, not a column that could not be read, and must not warn.
  it("reads a SQL NULL in a nullable column as a value", () => {
    const { roles, warnings } = parseRoleRows(
      psqlJson([{ ...baselineRow("analytics"), rolvaliduntil: null, rolcomment: null }])
    );

    expect(warnings).toEqual([]);
    expect(roles[0]?.validUntil).toBeNull();
    expect(roles[0]?.comment).toBeNull();
  });

  // The defect this parser was rewritten for. `psql -tAc` separates columns with
  // an unescaped `|`, so a role name containing one produced ten fields where
  // nine were expected and the row was dropped — from the check whose entire
  // purpose is catching the role adoption would reset.
  it("parses a role name containing the psql field delimiter", () => {
    const { roles, warnings } = parseRoleRows(psqlJson([baselineRow("read|er")]));

    expect(warnings).toEqual([]);
    expect(roles.map((role) => role.name)).toEqual(["read|er"]);
  });

  it("keeps a deviating role with a delimiter in its name", () => {
    const deviating = { ...baselineRow("read|er"), rolsuper: true };

    const { roles } = parseRoleRows(psqlJson([deviating]));

    expect(roles).toHaveLength(1);
    expect(roleMatchesBaseline(roles[0] as IParsedRoleRow)).toBe(false);
  });

  it("parses a membership containing the delimiter", () => {
    const row = { ...baselineRow("etl"), memberof: ["read|er", "writer"] };

    const { roles, warnings } = parseRoleRows(psqlJson([row]));

    expect(warnings).toEqual([]);
    expect(roles[0]?.memberOf).toEqual(["read|er", "writer"]);
  });

  it("parses newlines and quotes in a role name", () => {
    const { roles } = parseRoleRows(psqlJson([baselineRow('we"ird\nname')]));

    expect(roles.map((role) => role.name)).toEqual(['we"ird\nname']);
  });

  it("returns no roles and no warnings for an empty result set", () => {
    expect(parseRoleRows(psqlJson([]))).toEqual({ roles: [], warnings: [] });
  });

  // A dropped row is a role reported as compliant that was never looked at, so
  // anything unreadable has to surface — named — instead.
  describe("unreadable input", () => {
    it("warns, naming the role, when a column is missing", () => {
      const row: Record<string, unknown> = { ...baselineRow("analytics") };
      delete row["rolconnlimit"];

      const { roles, warnings } = parseRoleRows(psqlJson([row]));

      expect(roles).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('role "analytics"');
      expect(warnings[0]).toContain("rolconnlimit");
      expect(warnings[0]).toContain("NOT checked");
    });

    // A nullable column is only readable when it is present. Absent, it is an
    // attribute the check never saw — the same false all-clear as a dropped row.
    it.each(["rolvaliduntil", "rolcomment"])("warns when the nullable %s is absent", (column) => {
      const row: Record<string, unknown> = Object.fromEntries(
        Object.entries(baselineRow("analytics")).filter(([key]) => key !== column)
      );

      const { roles, warnings } = parseRoleRows(psqlJson([row]));

      expect(roles).toEqual([]);
      expect(warnings[0]).toContain(column);
      expect(warnings[0]).toContain("NOT checked");
    });

    it.each(["rolvaliduntil", "rolcomment"])(
      "warns when the nullable %s holds another type",
      (column) => {
        const { roles, warnings } = parseRoleRows(
          psqlJson([{ ...baselineRow("analytics"), [column]: 42 }])
        );

        expect(roles).toEqual([]);
        expect(warnings[0]).toContain(column);
      }
    );

    it("warns, naming the row's position, when even the name is unreadable", () => {
      const row: Record<string, unknown> = { ...baselineRow("analytics"), rolname: 42 };

      const { warnings } = parseRoleRows(psqlJson([row]));

      expect(warnings[0]).toContain("pg_roles row 1");
      expect(warnings[0]).toContain("rolname");
    });

    it("warns but keeps the rows it could read", () => {
      const { roles, warnings } = parseRoleRows(
        psqlJson([baselineRow("analytics"), { rolname: "broken" }])
      );

      expect(roles.map((role) => role.name)).toEqual(["analytics"]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('role "broken"');
    });

    it("warns when the output is not JSON at all", () => {
      const { roles, warnings } = parseRoleRows("analytics|t|f|f|f|t|-1|f|{}\n");

      expect(roles).toEqual([]);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("could not parse");
      expect(warnings[0]).toContain("pg_roles");
    });

    it("warns when the output is empty", () => {
      const { roles, warnings } = parseRoleRows("   \n");

      expect(roles).toEqual([]);
      expect(warnings[0]).toContain("no output");
    });

    // psql's `t`/`f` reaching this parser means the unwrapped query was run, and
    // every attribute would otherwise read as "not a boolean" — silently, if the
    // row were dropped.
    it("warns when booleans arrive in psql notation instead of JSON", () => {
      const row = { ...baselineRow("analytics"), rolcanlogin: "t" };

      const { roles, warnings } = parseRoleRows(psqlJson([row]));

      expect(roles).toEqual([]);
      expect(warnings[0]).toContain("rolcanlogin");
    });
  });
});

describe("roleMatchesBaseline", () => {
  const parse = (row: Record<string, unknown>): IParsedRoleRow =>
    parseRoleRows(psqlJson([row])).roles[0] as IParsedRoleRow;

  it("accepts a role sitting on the baseline", () => {
    expect(roleMatchesBaseline(parse(baselineRow("analytics")))).toBe(true);
  });

  it.each([
    ["rolcanlogin", false],
    ["rolsuper", true],
    ["rolcreatedb", true],
    ["rolcreaterole", true],
    ["rolinherit", false],
    ["rolbypassrls", true],
    ["rolreplication", true],
  ])("rejects a role whose %s deviates", (column, value) => {
    expect(roleMatchesBaseline(parse({ ...baselineRow("analytics"), [column]: value }))).toBe(
      false
    );
  });

  it("rejects a non-default connection limit", () => {
    expect(roleMatchesBaseline(parse({ ...baselineRow("analytics"), rolconnlimit: 5 }))).toBe(
      false
    );
  });

  // Memberships are the attribute adoption most visibly strips: a role granted
  // `pg_read_all_data` by hand loses it on the next apply.
  it("rejects a role holding a membership", () => {
    expect(
      roleMatchesBaseline(parse({ ...baselineRow("analytics"), memberof: ["pg_read_all_data"] }))
    ).toBe(false);
  });

  // `REPLICATION` was invisible to this check: a role carrying it was reported
  // as sitting on the baseline, and adoption then dropped the capability that
  // let it create replication slots.
  it("rejects a replication role", () => {
    expect(roleMatchesBaseline(parse({ ...baselineRow("analytics"), rolreplication: true }))).toBe(
      false
    );
  });

  // A manifest without `validUntil` sets VALID UNTIL infinity, so a finite
  // expiry is silently lifted — the password stops expiring.
  it("rejects a finite password expiry", () => {
    expect(
      roleMatchesBaseline(
        parse({ ...baselineRow("analytics"), rolvaliduntil: "2027-01-01T00:00:00+00:00" })
      )
    ).toBe(false);
  });

  // `ALTER ROLE` cannot write VALID UNTIL NULL, so CNPG spells "never expires"
  // as `infinity`. Both spellings are the baseline; flagging one would report a
  // deviation adoption would not make.
  it.each([null, "infinity", "INFINITY", " infinity "])(
    "accepts a password that never expires (%p)",
    (rolvaliduntil) => {
      expect(roleMatchesBaseline(parse({ ...baselineRow("analytics"), rolvaliduntil }))).toBe(true);
    }
  );

  // `-infinity` is an expiry in the past, not the absence of one.
  it("rejects an expiry of -infinity", () => {
    expect(
      roleMatchesBaseline(parse({ ...baselineRow("analytics"), rolvaliduntil: "-infinity" }))
    ).toBe(false);
  });

  it("rejects a role carrying a comment", () => {
    expect(
      roleMatchesBaseline(parse({ ...baselineRow("analytics"), rolcomment: "hand-made" }))
    ).toBe(false);
  });

  // The operator reads an absent comment and an empty one alike, so neither is
  // something adoption would change.
  it("accepts an empty comment", () => {
    expect(roleMatchesBaseline(parse({ ...baselineRow("analytics"), rolcomment: "" }))).toBe(true);
  });
});

describe("describeRoleDeviation", () => {
  it("renders memberships the way psql prints a text[]", () => {
    const role = parseRoleRows(
      psqlJson([{ ...baselineRow("analytics"), rolsuper: true, memberof: ["a", "b"] }])
    ).roles[0] as IParsedRoleRow;

    const description = describeRoleDeviation(role);

    expect(description).toContain('role "analytics"');
    expect(description).toContain("super=t");
    expect(description).toContain("memberof={a,b}");
    expect(description).toContain("baseline:");
  });

  it("renders an empty membership list as {}", () => {
    const role = parseRoleRows(psqlJson([{ ...baselineRow("analytics"), rolsuper: true }]))
      .roles[0] as IParsedRoleRow;

    expect(describeRoleDeviation(role)).toContain("memberof={}");
  });

  const describe1 = (row: Record<string, unknown>): string =>
    describeRoleDeviation(parseRoleRows(psqlJson([row])).roles[0] as IParsedRoleRow);

  it("names the attributes the check gained", () => {
    const description = describe1({
      ...baselineRow("analytics"),
      rolreplication: true,
      rolvaliduntil: "2027-01-01T00:00:00+00:00",
      rolcomment: "hand-made",
    });

    expect(description).toContain("replication=t");
    expect(description).toContain("validuntil=2027-01-01T00:00:00+00:00");
    expect(description).toContain('comment="hand-made"');
    expect(description).toContain("replication=f");
    expect(description).toContain("validuntil=(never)");
    expect(description).toContain("comment=(none)");
  });

  // A role sitting on the baseline in every attribute the message renders must
  // render identically to the baseline, or the report shows a "deviation" whose
  // two halves are the same.
  it("renders a never-expiring password the way the baseline reads", () => {
    const description = describe1({
      ...baselineRow("analytics"),
      rolsuper: true,
      rolvaliduntil: "infinity",
    });

    expect(description).toContain("validuntil=(never)");
    expect(description).not.toContain("infinity");
  });

  // A deviation is one line of a report; a comment is free text an operator
  // wrote and may be neither short nor single-line.
  it("collapses and truncates a long multi-line comment", () => {
    const description = describe1({
      ...baselineRow("analytics"),
      rolcomment: `owned by\nthe ${"platform ".repeat(12)}team`,
    });

    expect(description.split("\n")).toHaveLength(1);
    expect(description).toContain("owned by the platform");
    expect(description).toContain("…");
  });
});
