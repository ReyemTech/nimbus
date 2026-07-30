/**
 * Database ownership parsing for the `nimbus migrate` CNPG check.
 *
 * `Database` adoption issues `ALTER DATABASE … OWNER TO` unconditionally, so
 * that statement is only a no-op when the database's current owner already
 * matches what nimbus assigns. This module parses the database ownership
 * query from `docs/cnpg-declarative-databases.md` (reused verbatim, see
 * {@link DATABASE_OWNERSHIP_QUERY}).
 *
 * @module cli/migrate-cnpg-ownership
 */

import { splitNonEmptyLines } from "./migrate-exec.js";

/** Number of columns {@link DATABASE_OWNERSHIP_QUERY} returns. */
const DATABASE_OWNERSHIP_COLUMN_COUNT = 2;

/** Databases that are not created by `createDatabase()` and have no owner convention to check. */
export const SYSTEM_DATABASE_NAMES: readonly string[] = ["postgres"];

/** Database ownership query from `docs/cnpg-declarative-databases.md`. */
export const DATABASE_OWNERSHIP_QUERY = `SELECT d.datname, pg_get_userbyid(d.datdba)
FROM pg_database d WHERE NOT d.datistemplate ORDER BY 1`;

/** One row of {@link DATABASE_OWNERSHIP_QUERY}, parsed and typed. */
export interface IParsedDatabaseRow {
  readonly name: string;
  readonly owner: string;
}

/**
 * Parse one pipe-delimited row from {@link DATABASE_OWNERSHIP_QUERY}.
 *
 * @param line - Raw line of `psql -tAc` output
 * @returns The parsed row, or null when the line is malformed
 */
function parseDatabaseRow(line: string): IParsedDatabaseRow | null {
  const fields = line.split("|");
  if (fields.length !== DATABASE_OWNERSHIP_COLUMN_COUNT) {
    return null;
  }
  const [name, owner] = fields;
  if (!name || !owner) {
    return null;
  }
  return { name, owner };
}

/**
 * Parse every row returned by {@link DATABASE_OWNERSHIP_QUERY}.
 *
 * @param stdout - Raw `psql -tAc` output, one row per line
 * @returns Successfully parsed database rows (malformed lines are dropped)
 */
export function parseDatabaseRows(stdout: string): IParsedDatabaseRow[] {
  return splitNonEmptyLines(stdout)
    .map(parseDatabaseRow)
    .filter((row): row is IParsedDatabaseRow => row !== null);
}
