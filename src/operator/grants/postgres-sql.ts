/**
 * Pure compiler from portable grant specs to PostgreSQL SQL.
 *
 * Emits an atomic revoke-then-grant script: every privilege the role currently
 * holds is revoked, then the desired grants are applied. This converges without
 * needing to introspect prior state, and removal works because anything not
 * re-granted stays revoked. The whole script runs in one transaction so no
 * window of missing privileges is ever observable.
 *
 * @module operator/grants/postgres-sql
 */

import { AnyCloudError, ERROR_CODES } from "../../types/errors.js";
import type { IDatabaseGrant } from "../interfaces.js";

/**
 * Privileges accepted in {@link IDatabaseGrant.privileges}.
 *
 * Deliberately narrow: every entry here is either a privilege PostgreSQL
 * allows in a `GRANT ... ON ALL TABLES IN SCHEMA` / `GRANT ... ON <table>`
 * statement (`SELECT`, `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`,
 * `REFERENCES`, `TRIGGER`, `ALL PRIVILEGES`), or `CREATE`/`USAGE` for the
 * schema-scoped grant this compiler always emits alongside a table grant.
 * `EXECUTE`, `CONNECT`, and `TEMPORARY` are real PostgreSQL privileges but
 * apply to functions, databases, and tablespaces respectively — this
 * compiler has no emission path for them, so accepting them would pass
 * validation here and then fail (or silently do nothing useful) when the
 * script runs. Rejecting them at compile time surfaces the mistake early.
 */
const ALLOWED_PRIVILEGES: ReadonlySet<string> = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "USAGE",
  "CREATE",
  "ALL PRIVILEGES",
]);

/** Sentinel meaning "every current and future object in the schema". */
const ALL_OBJECTS = "all";
/** Schema used for a grant when {@link IDatabaseGrant.schema} is omitted. */
const DEFAULT_SCHEMA = "public";
/** Base tag for the `DO $tag$ ... $tag$;` block; bumped on collision. See {@link chooseDollarTag}. */
const BASE_DOLLAR_TAG = "nimbus";

/** Options for {@link compileGrantSql}. */
export interface ICompileOptions {
  /** Role receiving the privileges. */
  readonly role: string;
  /** Database owner — the role whose future objects default privileges apply to. */
  readonly owner: string;
  /** Desired grants. An empty list revokes everything the role holds. */
  readonly grants: ReadonlyArray<IDatabaseGrant>;
  /**
   * Raw SQL appended after the grants and before `COMMIT;` — it runs inside
   * the same surrounding transaction as everything else in the script, not
   * in a transaction of its own. It must therefore be both idempotent and
   * transaction-safe: statements that PostgreSQL refuses to run inside a
   * transaction block (e.g. `CREATE INDEX CONCURRENTLY`, `VACUUM`) will
   * error, and a stray `COMMIT;` here would close the transaction early and
   * leave the script's real trailing `COMMIT;` erroring outside any
   * transaction.
   */
  readonly extraSql?: ReadonlyArray<string>;
}

/**
 * Quote a PostgreSQL identifier, escaping embedded double quotes.
 *
 * @param name - Raw identifier
 * @returns The identifier wrapped in double quotes and safe to interpolate
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Validate and normalise a privilege keyword.
 *
 * Privileges are SQL keywords and cannot be quoted, so they are checked against
 * an allowlist rather than escaped.
 *
 * @param privilege - Raw privilege name, any case
 * @returns The upper-cased privilege
 * @throws {AnyCloudError} code `UNSUPPORTED_PRIVILEGE` when not in the allowlist
 */
export function normalizePrivilege(privilege: string): string {
  const normalized = privilege.trim().toUpperCase().replace(/\s+/g, " ");
  if (!ALLOWED_PRIVILEGES.has(normalized)) {
    throw new AnyCloudError(
      `Unsupported privilege "${privilege}". Allowed: ${[...ALLOWED_PRIVILEGES].join(", ")}.`,
      ERROR_CODES.UNSUPPORTED_PRIVILEGE
    );
  }
  return normalized;
}

/**
 * Quote a string as a SQL literal, escaping embedded single quotes.
 *
 * Used for values passed to functions such as `has_schema_privilege(...)` and
 * `format(...)`, never for identifiers interpolated directly into DDL.
 *
 * @param value - Raw string value
 * @returns The value wrapped in single quotes and safe to interpolate
 */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Derive a dollar-quote tag for a `DO $tag$ ... $tag$;` block that cannot
 * collide with any of the given values.
 *
 * PostgreSQL's dollar-quoting has no escape mechanism: whichever `$tag$`
 * appears first inside the body — even embedded in what the author intended
 * as inert string data — closes the block early, and everything after is
 * parsed as top-level SQL. Hardcoding a tag is therefore an injection hole
 * whenever a role or owner name is attacker-influenced. This starts at
 * `nimbus` and, on collision, tries `nimbus0`, `nimbus1`, ... until the
 * candidate tag does not appear (as `$tag$`) in any supplied value.
 *
 * @param values - Every string that will be embedded inside the DO block body
 * @returns A tag guaranteed not to appear as `$tag$` in any of `values`
 */
function chooseDollarTag(values: ReadonlyArray<string>): string {
  let candidate = BASE_DOLLAR_TAG;
  let suffix = 0;
  while (values.some((value) => value.includes(`$${candidate}$`))) {
    candidate = `${BASE_DOLLAR_TAG}${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * Compile a grant spec into an idempotent, transactional SQL script.
 *
 * @param options - Role, owner, desired grants, and optional trailing SQL
 * @returns A complete SQL script beginning with `BEGIN;` and ending `COMMIT;`
 * @throws {AnyCloudError} code `UNSUPPORTED_PRIVILEGE` when a privilege is not
 *   in the allowlist
 *
 * @example Read-only access to every current and future table in a schema
 * ```typescript
 * const sql = compileGrantSql({
 *   role: "reader",
 *   owner: "etl",
 *   grants: [{ privileges: ["SELECT"], schema: "marts", objects: "all" }],
 * });
 * // sql === "BEGIN;\nDO $nimbus$ ... GRANT SELECT ON ALL TABLES IN SCHEMA \"marts\" TO \"reader\";\n...\nCOMMIT;"
 * ```
 */
export function compileGrantSql(options: ICompileOptions): string {
  const { role, owner, grants, extraSql = [] } = options;
  const qRole = quoteIdentifier(role);
  const qOwner = quoteIdentifier(owner);
  const lRole = quoteLiteral(role);
  const lOwner = quoteLiteral(owner);
  const tag = chooseDollarTag([role, owner]);

  const statements: string[] = ["BEGIN;"];

  // Revoke every privilege the role currently holds, discovered at runtime.
  // Every non-system schema is visited unconditionally (not just ones the
  // role currently has USAGE on) so that privileges surviving under a
  // separately-revoked schema are still caught — REVOKE against a schema the
  // role holds nothing in is a harmless no-op. format(%I) quotes
  // identifiers; the role/owner names are passed as literal parameters to
  // format rather than concatenated into DDL.
  statements.push(
    [
      `DO $${tag}$`,
      "DECLARE s record;",
      "BEGIN",
      "  FOR s IN",
      "    SELECT nspname FROM pg_namespace",
      "    WHERE nspname NOT LIKE 'pg\\_%'",
      "      AND nspname <> 'information_schema'",
      "  LOOP",
      `    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', s.nspname, ${lRole});`,
      `    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', s.nspname, ${lRole});`,
      `    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', s.nspname, ${lRole});`,
      `    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', ${lOwner}, s.nspname, ${lRole});`,
      "  END LOOP;",
      "END",
      `$${tag}$;`,
    ].join("\n")
  );

  for (const grant of grants) {
    const privileges = grant.privileges.map(normalizePrivilege).join(", ");
    const schema = grant.schema ?? DEFAULT_SCHEMA;
    const qSchema = quoteIdentifier(schema);
    const objects = grant.objects ?? ALL_OBJECTS;

    statements.push(`GRANT USAGE ON SCHEMA ${qSchema} TO ${qRole};`);

    if (objects === ALL_OBJECTS) {
      statements.push(`GRANT ${privileges} ON ALL TABLES IN SCHEMA ${qSchema} TO ${qRole};`);
      statements.push(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${qOwner} IN SCHEMA ${qSchema} ` +
          `GRANT ${privileges} ON TABLES TO ${qRole};`
      );
    } else {
      statements.push(`GRANT ${privileges} ON ${qSchema}.${quoteIdentifier(objects)} TO ${qRole};`);
    }
  }

  statements.push(...extraSql);
  statements.push("COMMIT;");

  return statements.join("\n");
}
