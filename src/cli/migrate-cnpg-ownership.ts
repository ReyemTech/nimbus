/**
 * Database ownership parsing for the `nimbus migrate` CNPG check.
 *
 * `Database` adoption issues `ALTER DATABASE … OWNER TO` unconditionally, so
 * that statement is only a no-op when the database's current owner already
 * matches what nimbus assigns. This module parses the database ownership
 * query from `docs/cnpg-declarative-databases.md` (reused verbatim, see
 * {@link DATABASE_OWNERSHIP_QUERY}).
 *
 * The query is run through {@link toJsonRowsQuery} for the reason spelt out in
 * {@link module:cli/migrate-psql}: `psql -tAc` escapes nothing, so a database or
 * owner name containing a `|` split into three fields where two were expected
 * and the row was silently dropped — from the check whose job is to notice that
 * exact database. Rows that still cannot be read come back as warnings.
 *
 * @module cli/migrate-cnpg-ownership
 */

import { parseJsonRows, readString, toJsonRowsQuery } from "./migrate-psql.js";

/** Databases that are not created by `createDatabase()` and have no owner convention to check. */
export const SYSTEM_DATABASE_NAMES: readonly string[] = ["postgres"];

/** Database ownership query from `docs/cnpg-declarative-databases.md`. */
export const DATABASE_OWNERSHIP_QUERY = `SELECT d.datname, pg_get_userbyid(d.datdba) AS owner
FROM pg_database d WHERE NOT d.datistemplate ORDER BY 1`;

/** {@link DATABASE_OWNERSHIP_QUERY} as the JSON document {@link parseDatabaseRows} reads. */
export const DATABASE_OWNERSHIP_JSON_QUERY = toJsonRowsQuery(DATABASE_OWNERSHIP_QUERY);

/** What this query reads, named in warnings. */
const SUBJECT = "pg_database";

/** Columns {@link DATABASE_OWNERSHIP_QUERY} returns, by the name `row_to_json` gives them. */
const DATABASE_COLUMNS = {
  NAME: "datname",
  OWNER: "owner",
} as const;

/** One row of {@link DATABASE_OWNERSHIP_QUERY}, parsed and typed. */
export interface IParsedDatabaseRow {
  readonly name: string;
  readonly owner: string;
}

/** Parsed databases, plus a warning for every row that could not be read. */
export interface IDatabaseRowsResult {
  /** Rows that parsed cleanly. */
  readonly databases: ReadonlyArray<IParsedDatabaseRow>;
  /** One line per unreadable row; never empty when a row was skipped. */
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Parse every row returned by {@link DATABASE_OWNERSHIP_JSON_QUERY}.
 *
 * @param stdout - Raw `psql -tAc` output of the JSON-wrapped query
 * @returns The databases that parsed, and a warning for every row that did not
 */
export function parseDatabaseRows(stdout: string): IDatabaseRowsResult {
  const parsed = parseJsonRows(stdout, SUBJECT);
  const databases: IParsedDatabaseRow[] = [];
  const warnings: string[] = [...parsed.warnings];

  parsed.rows.forEach((row: Record<string, unknown>, index: number) => {
    const name = readString(row, DATABASE_COLUMNS.NAME);
    const owner = readString(row, DATABASE_COLUMNS.OWNER);
    if (name === undefined || owner === undefined) {
      const columns = [
        [DATABASE_COLUMNS.NAME, name],
        [DATABASE_COLUMNS.OWNER, owner],
      ]
        .filter(([, value]) => value === undefined)
        .map(([column]) => column)
        .join(", ");
      const where = name === undefined ? `${SUBJECT} row ${index + 1}` : `database "${name}"`;
      warnings.push(
        `${where}: could not read ${columns} from the ${SUBJECT} query output, so this ` +
          "database's ownership was NOT checked."
      );
      return;
    }
    databases.push({ name, owner });
  });

  return { databases, warnings };
}
