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
 * The baseline covers every attribute `DatabaseRole.spec` can express, not the
 * subset that is easy to query. Checking fewer is the same false all-clear as
 * skipping a row: `replication`, `validUntil` and `comment` were missing, so a
 * role carrying `REPLICATION` or a finite `VALID UNTIL` was reported as sitting
 * on the baseline and then had exactly that stripped on the first reconcile.
 * Every field of the CRD's `spec` that maps onto a role attribute is read here;
 * the ones that do not (`cluster`, `name`, `ensure`, `databaseRoleReclaimPolicy`,
 * `clientCertificate`) name or govern the CR rather than the role, and
 * `passwordSecret` carries the password migration re-applies deliberately.
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
  readNullableString,
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
       r.rolinherit, r.rolconnlimit, r.rolbypassrls, r.rolreplication, r.rolvaliduntil,
       shobj_description(r.oid, 'pg_authid') AS rolcomment,
       coalesce(array_agg(m.rolname) FILTER (WHERE m.rolname IS NOT NULL), '{}') AS memberof
FROM pg_roles r
LEFT JOIN pg_auth_members am ON am.member = r.oid
LEFT JOIN pg_roles m ON m.oid = am.roleid
WHERE r.rolname NOT LIKE 'pg\\_%'
GROUP BY 1,2,3,4,5,6,7,8,9,10,11 ORDER BY 1`;

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
  CAN_REPLICATE: "rolreplication",
  VALID_UNTIL: "rolvaliduntil",
  COMMENT: "rolcomment",
  MEMBER_OF: "memberof",
} as const;

/**
 * PostgreSQL's other spelling of "this password never expires".
 *
 * `ALTER ROLE` cannot set `VALID UNTIL NULL`, so CNPG writes `infinity` when the
 * manifest omits `validUntil`. A role already carrying `infinity` is therefore
 * on the baseline just as surely as one carrying NULL.
 */
const INFINITE_VALID_UNTIL = "infinity";

/** How a password with no expiry is rendered in a deviation line. */
const NEVER_EXPIRES = "(never)";

/** How a role with no comment is rendered in a deviation line. */
const NO_COMMENT = "(none)";

/** Longest role comment echoed back in a deviation line. */
const MAX_COMMENT_LENGTH = 60;

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
  readonly canReplicate: boolean;
  /** Password expiry, or null when the password never expires. */
  readonly validUntil: string | null;
  /** Role comment, or null when the role carries none. */
  readonly comment: string | null;
  readonly memberOf: ReadonlyArray<string>;
}

/** Every attribute of a role, without the name that identifies it. */
type RoleAttributes = Omit<IParsedRoleRow, "name">;

/**
 * The attribute set `DatabaseRole` adoption leaves untouched.
 *
 * Both the baseline check and the deviation message are derived from this one
 * value, so the message can never describe a baseline the check does not apply.
 */
const BASELINE_ATTRIBUTES: RoleAttributes = {
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
};

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
 * Whether a role's password expiry is the one adoption would leave alone.
 *
 * @param validUntil - `rolvaliduntil`, or null for a SQL NULL
 * @returns True when the password never expires
 */
function hasNoPasswordExpiry(validUntil: string | null): boolean {
  return validUntil === null || validUntil.trim().toLowerCase() === INFINITE_VALID_UNTIL;
}

/**
 * Whether a role carries no comment for adoption to clear.
 *
 * An empty comment and no comment at all are indistinguishable to the operator,
 * which reads both as the empty string, so both sit on the baseline.
 *
 * @param comment - `rolcomment`, or null for a SQL NULL
 * @returns True when the role has nothing adoption would overwrite
 */
function hasNoComment(comment: string | null): boolean {
  return comment === null || comment === "";
}

/**
 * Render a password expiry for report output.
 *
 * A password that never expires reads as {@link NEVER_EXPIRES} whichever way
 * PostgreSQL spells it, so a role on the baseline renders identically to the
 * baseline rather than as a deviation with the same meaning.
 *
 * @param validUntil - `rolvaliduntil`, or null for a SQL NULL
 * @returns The expiry, or a phrase saying there is none
 */
function toReportedValidUntil(validUntil: string | null): string {
  // The null test is redundant against hasNoPasswordExpiry and kept because it
  // is what narrows the type of the value returned below.
  if (validUntil === null || hasNoPasswordExpiry(validUntil)) {
    return NEVER_EXPIRES;
  }
  return validUntil;
}

/**
 * Render a role comment for report output.
 *
 * A comment is free text an operator wrote: it may be long and may contain
 * newlines, and a deviation line is one line, so it is collapsed and truncated.
 *
 * @param comment - `rolcomment`, or null for a SQL NULL
 * @returns The quoted comment, or a phrase saying there is none
 */
function toReportedComment(comment: string | null): string {
  if (comment === null || comment === "") {
    return NO_COMMENT;
  }
  const oneLine = comment.replace(/\s+/g, " ").trim();
  const shortened =
    oneLine.length > MAX_COMMENT_LENGTH ? `${oneLine.slice(0, MAX_COMMENT_LENGTH)}…` : oneLine;
  return `"${shortened}"`;
}

/**
 * Render one role's attributes in the compact form the report prints.
 *
 * @param attributes - A parsed role's attributes, or {@link BASELINE_ATTRIBUTES}
 * @returns A single line of `key=value` pairs
 */
function describeAttributes(attributes: RoleAttributes): string {
  return (
    `login=${toPsqlBoolean(attributes.canLogin)} super=${toPsqlBoolean(attributes.isSuperuser)} ` +
    `createdb=${toPsqlBoolean(attributes.canCreateDb)} ` +
    `createrole=${toPsqlBoolean(attributes.canCreateRole)} ` +
    `inherit=${toPsqlBoolean(attributes.inherits)} connlimit=${attributes.connectionLimit} ` +
    `bypassrls=${toPsqlBoolean(attributes.bypassesRls)} ` +
    `replication=${toPsqlBoolean(attributes.canReplicate)} ` +
    `validuntil=${toReportedValidUntil(attributes.validUntil)} ` +
    `comment=${toReportedComment(attributes.comment)} memberof=${toPsqlArray(attributes.memberOf)}`
  );
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
  const canReplicate = readBoolean(row, ROLE_COLUMNS.CAN_REPLICATE);
  const validUntil = readNullableString(row, ROLE_COLUMNS.VALID_UNTIL);
  const comment = readNullableString(row, ROLE_COLUMNS.COMMENT);
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
    [ROLE_COLUMNS.CAN_REPLICATE, canReplicate],
    [ROLE_COLUMNS.VALID_UNTIL, validUntil],
    [ROLE_COLUMNS.COMMENT, comment],
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
    canReplicate === undefined ||
    validUntil === undefined ||
    comment === undefined ||
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
      canReplicate,
      validUntil,
      comment,
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
 * Whether `DatabaseRole` adoption would leave this role's attributes alone.
 *
 * Every attribute `DatabaseRole.spec` can express is compared, because adoption
 * resets each one the manifest omits — checking a subset reports roles as safe
 * that adoption is about to change. See {@link BASELINE_ATTRIBUTES}.
 *
 * @param role - Parsed role row
 * @returns True when every attribute matches the baseline
 */
export function roleMatchesBaseline(role: IParsedRoleRow): boolean {
  return (
    role.canLogin === BASELINE_ATTRIBUTES.canLogin &&
    role.isSuperuser === BASELINE_ATTRIBUTES.isSuperuser &&
    role.canCreateDb === BASELINE_ATTRIBUTES.canCreateDb &&
    role.canCreateRole === BASELINE_ATTRIBUTES.canCreateRole &&
    role.inherits === BASELINE_ATTRIBUTES.inherits &&
    role.connectionLimit === BASELINE_ATTRIBUTES.connectionLimit &&
    role.bypassesRls === BASELINE_ATTRIBUTES.bypassesRls &&
    role.canReplicate === BASELINE_ATTRIBUTES.canReplicate &&
    hasNoPasswordExpiry(role.validUntil) &&
    hasNoComment(role.comment) &&
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
  return (
    `role "${role.name}": ${describeAttributes(role)} ` +
    `(baseline: ${describeAttributes(BASELINE_ATTRIBUTES)})`
  );
}
