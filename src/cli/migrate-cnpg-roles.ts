/**
 * Role attribute baseline and parsing for the `nimbus migrate` CNPG check.
 *
 * `DatabaseRole` adoption ALTERs an existing role to match the manifest,
 * forcing attributes the manifest omits back to their defaults. nimbus's
 * manifest sets only `login: true`, so every other attribute must already sit
 * at the PostgreSQL default for adoption to be a no-op. This module parses the
 * `pg_roles` query from `docs/cnpg-declarative-databases.md` (reused verbatim,
 * see {@link ROLE_ATTRIBUTES_QUERY}) and flags rows that deviate.
 *
 * @module cli/migrate-cnpg-roles
 */

import { splitNonEmptyLines } from "./migrate-exec.js";

/** Number of columns {@link ROLE_ATTRIBUTES_QUERY} returns. */
const ROLE_ATTRIBUTES_COLUMN_COUNT = 9;

/**
 * Operator-managed roles that intentionally do not follow the nimbus baseline
 * (e.g. `postgres` is a superuser by definition). Excluded from role deviation
 * reporting so the check only flags roles nimbus actually provisions.
 */
export const BUILTIN_ROLE_NAMES: readonly string[] = [
  "postgres",
  "streaming_replica",
  "cnpg_pooler_pgbouncer",
];

/**
 * `pg_roles` query from `docs/cnpg-declarative-databases.md`, reused verbatim so this
 * check and the documented manual procedure never drift apart.
 */
export const ROLE_ATTRIBUTES_QUERY = `SELECT r.rolname, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
       r.rolinherit, r.rolconnlimit, r.rolbypassrls,
       coalesce(array_agg(m.rolname) FILTER (WHERE m.rolname IS NOT NULL), '{}') AS memberof
FROM pg_roles r
LEFT JOIN pg_auth_members am ON am.member = r.oid
LEFT JOIN pg_roles m ON m.oid = am.roleid
WHERE r.rolname NOT LIKE 'pg\\_%'
GROUP BY 1,2,3,4,5,6,7,8 ORDER BY 1`;

/** One row of {@link ROLE_ATTRIBUTES_QUERY}, parsed and typed. */
export interface IParsedRoleRow {
  readonly name: string;
  readonly canLogin: boolean;
  readonly isSuperuser: boolean;
  readonly canCreateDb: boolean;
  readonly canCreateRole: boolean;
  readonly inherits: boolean;
  readonly connectionLimit: number;
  readonly bypassesRls: boolean;
  readonly memberOf: string;
}

/**
 * Parse a `psql -tAc` boolean cell (`t`/`f`) into a JavaScript boolean.
 *
 * @param value - Raw cell value
 * @returns True only when the cell is exactly "t"
 */
function parsePsqlBoolean(value: string): boolean {
  return value === "t";
}

/**
 * Render a boolean back into psql's `t`/`f` notation for report output.
 *
 * @param value - Boolean to render
 * @returns "t" or "f"
 */
function toPsqlBoolean(value: boolean): string {
  return value ? "t" : "f";
}

/**
 * Parse one pipe-delimited row from {@link ROLE_ATTRIBUTES_QUERY}.
 *
 * @param line - Raw line of `psql -tAc` output
 * @returns The parsed row, or null when the line is malformed
 */
function parseRoleRow(line: string): IParsedRoleRow | null {
  const fields = line.split("|");
  if (fields.length !== ROLE_ATTRIBUTES_COLUMN_COUNT) {
    return null;
  }
  const [
    name,
    canLogin,
    isSuperuser,
    canCreateDb,
    canCreateRole,
    inherits,
    connlimit,
    bypassrls,
    memberOf,
  ] = fields;
  if (!name) {
    return null;
  }
  const connectionLimit = Number(connlimit);
  if (Number.isNaN(connectionLimit)) {
    return null;
  }
  return {
    name,
    canLogin: parsePsqlBoolean(canLogin ?? ""),
    isSuperuser: parsePsqlBoolean(isSuperuser ?? ""),
    canCreateDb: parsePsqlBoolean(canCreateDb ?? ""),
    canCreateRole: parsePsqlBoolean(canCreateRole ?? ""),
    inherits: parsePsqlBoolean(inherits ?? ""),
    connectionLimit,
    bypassesRls: parsePsqlBoolean(bypassrls ?? ""),
    memberOf: memberOf ?? "",
  };
}

/**
 * Parse every row returned by {@link ROLE_ATTRIBUTES_QUERY}.
 *
 * @param stdout - Raw `psql -tAc` output, one row per line
 * @returns Successfully parsed role rows (malformed lines are dropped)
 */
export function parseRoleRows(stdout: string): IParsedRoleRow[] {
  return splitNonEmptyLines(stdout)
    .map(parseRoleRow)
    .filter((row): row is IParsedRoleRow => row !== null);
}

/**
 * The baseline a nimbus-managed role must match for `DatabaseRole` adoption to
 * be a no-op: `login=t, super=f, createdb=f, createrole=f, inherit=t,
 * connlimit=-1, bypassrls=f, memberof={}`.
 *
 * @param role - Parsed role row
 * @returns True when every attribute matches the baseline
 */
export function roleMatchesBaseline(role: IParsedRoleRow): boolean {
  return (
    role.canLogin === true &&
    role.isSuperuser === false &&
    role.canCreateDb === false &&
    role.canCreateRole === false &&
    role.inherits === true &&
    role.connectionLimit === -1 &&
    role.bypassesRls === false &&
    role.memberOf === "{}"
  );
}

/**
 * Describe how a role's attributes deviate from the nimbus baseline, for report output.
 *
 * @param role - Parsed role row that failed {@link roleMatchesBaseline}
 * @returns A one-line, human-readable description of the deviation
 */
export function describeRoleDeviation(role: IParsedRoleRow): string {
  const actual =
    `login=${toPsqlBoolean(role.canLogin)} super=${toPsqlBoolean(role.isSuperuser)} ` +
    `createdb=${toPsqlBoolean(role.canCreateDb)} createrole=${toPsqlBoolean(role.canCreateRole)} ` +
    `inherit=${toPsqlBoolean(role.inherits)} connlimit=${role.connectionLimit} ` +
    `bypassrls=${toPsqlBoolean(role.bypassesRls)} memberof=${role.memberOf}`;
  return (
    `role "${role.name}": ${actual} ` +
    `(baseline: login=t super=f createdb=f createrole=f inherit=t connlimit=-1 bypassrls=f memberof={})`
  );
}
