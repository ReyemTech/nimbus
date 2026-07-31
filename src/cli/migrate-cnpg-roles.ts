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
 * The query is run through {@link toJsonRowsQuery} rather than read as `psql`'s
 * pipe-delimited output: a role name may contain a `|`, and psql escapes
 * nothing, so such a row parsed as ten fields instead of nine and was discarded.
 * The check then reported that every role matched the baseline while having
 * skipped precisely the role whose attributes adoption would reset. Nothing is
 * dropped now — a row that still cannot be read is returned as a warning.
 *
 * @module cli/migrate-cnpg-roles
 */

import {
  parseJsonRows,
  readBoolean,
  readNumber,
  readString,
  readStringArray,
  toJsonRowsQuery,
} from "./migrate-psql.js";

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

/** {@link ROLE_ATTRIBUTES_QUERY} as the JSON document {@link parseRoleRows} reads. */
export const ROLE_ATTRIBUTES_JSON_QUERY = toJsonRowsQuery(ROLE_ATTRIBUTES_QUERY);

/** What this query reads, named in warnings. */
const SUBJECT = "pg_roles";

/** Columns {@link ROLE_ATTRIBUTES_QUERY} returns, by the name `row_to_json` gives them. */
const ROLE_COLUMNS = {
  NAME: "rolname",
  CAN_LOGIN: "rolcanlogin",
  IS_SUPERUSER: "rolsuper",
  CAN_CREATE_DB: "rolcreatedb",
  CAN_CREATE_ROLE: "rolcreaterole",
  INHERITS: "rolinherit",
  CONNECTION_LIMIT: "rolconnlimit",
  BYPASSES_RLS: "rolbypassrls",
  MEMBER_OF: "memberof",
} as const;

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
  readonly memberOf: ReadonlyArray<string>;
}

/** Parsed roles, plus a warning for every row that could not be read. */
export interface IRoleRowsResult {
  /** Rows that parsed cleanly. */
  readonly roles: ReadonlyArray<IParsedRoleRow>;
  /** One line per unreadable row; never empty when a row was skipped. */
  readonly warnings: ReadonlyArray<string>;
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
 * Render role memberships the way psql prints a `text[]`, for report output.
 *
 * @param memberOf - Roles this role is a member of
 * @returns The memberships in `{a,b}` form
 */
function toPsqlArray(memberOf: ReadonlyArray<string>): string {
  return `{${memberOf.join(",")}}`;
}

/**
 * Name a row in a warning, using its role name when that much was readable.
 *
 * @param index - Zero-based position in the result
 * @param name - Role name, when it could be read
 * @returns A phrase identifying the row to an operator
 */
function describeRow(index: number, name: string | undefined): string {
  return name === undefined ? `${SUBJECT} row ${index + 1}` : `role "${name}"`;
}

/** A row that parsed, or the reason it did not. */
type RoleRowOutcome = { readonly role: IParsedRoleRow } | { readonly warning: string };

/**
 * Parse one row of {@link ROLE_ATTRIBUTES_QUERY}.
 *
 * @param row - One object from the query's JSON output
 * @param index - Zero-based position in the result, for the warning
 * @returns The parsed row, or a warning naming the row and its bad columns
 */
function parseRoleRow(row: Record<string, unknown>, index: number): RoleRowOutcome {
  const name = readString(row, ROLE_COLUMNS.NAME);
  const canLogin = readBoolean(row, ROLE_COLUMNS.CAN_LOGIN);
  const isSuperuser = readBoolean(row, ROLE_COLUMNS.IS_SUPERUSER);
  const canCreateDb = readBoolean(row, ROLE_COLUMNS.CAN_CREATE_DB);
  const canCreateRole = readBoolean(row, ROLE_COLUMNS.CAN_CREATE_ROLE);
  const inherits = readBoolean(row, ROLE_COLUMNS.INHERITS);
  const connectionLimit = readNumber(row, ROLE_COLUMNS.CONNECTION_LIMIT);
  const bypassesRls = readBoolean(row, ROLE_COLUMNS.BYPASSES_RLS);
  const memberOf = readStringArray(row, ROLE_COLUMNS.MEMBER_OF);

  const unreadable: ReadonlyArray<readonly [string, unknown]> = [
    [ROLE_COLUMNS.NAME, name],
    [ROLE_COLUMNS.CAN_LOGIN, canLogin],
    [ROLE_COLUMNS.IS_SUPERUSER, isSuperuser],
    [ROLE_COLUMNS.CAN_CREATE_DB, canCreateDb],
    [ROLE_COLUMNS.CAN_CREATE_ROLE, canCreateRole],
    [ROLE_COLUMNS.INHERITS, inherits],
    [ROLE_COLUMNS.CONNECTION_LIMIT, connectionLimit],
    [ROLE_COLUMNS.BYPASSES_RLS, bypassesRls],
    [ROLE_COLUMNS.MEMBER_OF, memberOf],
  ];

  if (
    name === undefined ||
    canLogin === undefined ||
    isSuperuser === undefined ||
    canCreateDb === undefined ||
    canCreateRole === undefined ||
    inherits === undefined ||
    connectionLimit === undefined ||
    bypassesRls === undefined ||
    memberOf === undefined
  ) {
    const columns = unreadable
      .filter(([, value]) => value === undefined)
      .map(([column]) => column)
      .join(", ");
    return {
      warning:
        `${describeRow(index, name)}: could not read ${columns} from the ${SUBJECT} query ` +
        "output, so this role was NOT checked against the adoption baseline.",
    };
  }

  return {
    role: {
      name,
      canLogin,
      isSuperuser,
      canCreateDb,
      canCreateRole,
      inherits,
      connectionLimit,
      bypassesRls,
      memberOf,
    },
  };
}

/**
 * Parse every row returned by {@link ROLE_ATTRIBUTES_JSON_QUERY}.
 *
 * @param stdout - Raw `psql -tAc` output of the JSON-wrapped query
 * @returns The roles that parsed, and a warning for every row that did not
 */
export function parseRoleRows(stdout: string): IRoleRowsResult {
  const parsed = parseJsonRows(stdout, SUBJECT);
  const roles: IParsedRoleRow[] = [];
  const warnings: string[] = [...parsed.warnings];

  parsed.rows.forEach((row: Record<string, unknown>, index: number) => {
    const outcome = parseRoleRow(row, index);
    if ("role" in outcome) {
      roles.push(outcome.role);
      return;
    }
    warnings.push(outcome.warning);
  });

  return { roles, warnings };
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
    role.memberOf.length === 0
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
    `bypassrls=${toPsqlBoolean(role.bypassesRls)} memberof=${toPsqlArray(role.memberOf)}`;
  return (
    `role "${role.name}": ${actual} ` +
    `(baseline: login=t super=f createdb=f createrole=f inherit=t connlimit=-1 bypassrls=f memberof={})`
  );
}
