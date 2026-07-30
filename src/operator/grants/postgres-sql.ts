/**
 * Pure compiler from portable grant specs to PostgreSQL SQL.
 *
 * Emits an atomic revoke-then-grant script: every privilege the role currently
 * holds is revoked, then the desired grants are applied. This converges without
 * needing to introspect prior state, and removal works because anything not
 * re-granted stays revoked. The whole script runs in one transaction so no
 * window of missing privileges is ever observable.
 *
 * The one exception is a script whose role IS the owner: revoking there would
 * take the owner's access to its own objects away, so the preamble is skipped.
 *
 * @module operator/grants/postgres-sql
 */

import { normalizePrivilegeAgainst } from "./privileges.js";
import type { IDatabaseGrant } from "../interfaces.js";

/**
 * Privileges accepted in {@link IDatabaseGrant.privileges}.
 *
 * Deliberately narrow: every entry is a privilege PostgreSQL allows in the
 * only grant statements this compiler emits — `GRANT ... ON ALL TABLES IN
 * SCHEMA <schema>` and `GRANT ... ON <schema>.<table>`. A keyword that is a
 * real PostgreSQL privilege elsewhere but has no emission path here is
 * rejected at compile time rather than passing validation and failing when
 * the script runs:
 *
 * - `EXECUTE` applies to functions, `CONNECT` and `TEMPORARY` to databases.
 * - `USAGE` and `CREATE` apply to schemas (and `USAGE` to sequences and
 *   types), never to relations. They were briefly accepted here, which was a
 *   bug: with `objects` defaulting to `"all"` they rendered as
 *   `GRANT USAGE ON ALL TABLES IN SCHEMA "x" TO "r";`, which PostgreSQL
 *   rejects with `invalid privilege type USAGE for relation`. Nothing is lost
 *   by removing them — {@link compileGrantSql} already emits
 *   `GRANT USAGE ON SCHEMA` for every grant, and schema `CREATE` is not
 *   something this compiler grants at all.
 */
const ALLOWED_PRIVILEGES: ReadonlySet<string> = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "ALL PRIVILEGES",
]);

/**
 * Privileges whose holder needs the schema's sequences to be usable.
 *
 * Inserting into a `serial`/`identity` column calls `nextval()` on the column's
 * owning sequence, which is a separate object with its own ACL: without
 * `USAGE` on it every such `INSERT` fails with `permission denied for
 * sequence`. `UPDATE` is included because updating a key column can call
 * `nextval()` the same way, and `ALL PRIVILEGES` because it subsumes both.
 * `SELECT`, `DELETE`, `TRUNCATE`, `REFERENCES`, and `TRIGGER` never consume a
 * sequence value, so a read-only role is not silently widened.
 */
const SEQUENCE_IMPLYING_PRIVILEGES: ReadonlySet<string> = new Set([
  "INSERT",
  "UPDATE",
  "ALL PRIVILEGES",
]);

/**
 * Privileges granted on sequences for a role that holds a write grant.
 *
 * `USAGE` is what `nextval()` requires; `SELECT` allows reading the current
 * value (`currval`). `UPDATE` — which would let the role `setval()` a sequence
 * to an arbitrary value — is deliberately excluded, and correspondingly never
 * revoked. See {@link compileGrantSql} for the invariant that ties the two.
 */
const SEQUENCE_PRIVILEGES = "USAGE, SELECT";

/** Engine name used when reporting a rejected privilege. */
const ENGINE_NAME = "PostgreSQL";

/** Sentinel meaning "every current and future object in the schema". */
const ALL_OBJECTS = "all";
/** Schema used for a grant when {@link IDatabaseGrant.schema} is omitted. */
const DEFAULT_SCHEMA = "public";
/** Base tag for the `DO $tag$ ... $tag$;` block; bumped on collision. See {@link chooseDollarTag}. */
const BASE_DOLLAR_TAG = "nimbus";

/** Options for {@link compileGrantSql}. */
export interface ICompileOptions {
  /**
   * Role receiving the privileges. When it equals {@link ICompileOptions.owner}
   * the revoke preamble is omitted — see {@link compileGrantSql}.
   */
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
 * Validate and normalise a privilege keyword for PostgreSQL.
 *
 * Privileges are SQL keywords and cannot be quoted, so they are checked against
 * an allowlist rather than escaped. The allowlist is PostgreSQL's own — see
 * {@link normalizePrivilegeAgainst} for why it is not shared with MariaDB.
 *
 * @param privilege - Raw privilege name, any case
 * @returns The upper-cased privilege
 * @throws {AnyCloudError} code `UNSUPPORTED_PRIVILEGE` when not in the allowlist
 */
export function normalizePrivilege(privilege: string): string {
  return normalizePrivilegeAgainst(privilege, ALLOWED_PRIVILEGES, ENGINE_NAME);
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
 * **Invariant: the revoke preamble never strips a privilege the grant path
 * cannot restore.** Convergence only works if every privilege the preamble
 * removes can be put back by some grant this compiler is able to emit —
 * otherwise a role loses access permanently the first time any grant is
 * reconciled, with no configuration that brings it back. The preamble is
 * therefore scoped to exactly three things: all privileges on tables (restored
 * by `ALL PRIVILEGES`), `USAGE, SELECT` on sequences (restored alongside any
 * write grant, see {@link SEQUENCE_IMPLYING_PRIVILEGES}), and `USAGE` on the
 * schema (restored for every grant). Schema `CREATE` and sequence `UPDATE` are
 * left alone precisely because nothing here can grant them.
 *
 * When `role` and `owner` name the same role the revoke preamble is omitted:
 * an owner's rights over its own objects are ordinary ACL entries it is
 * allowed to revoke from itself, so reconciling "the owner holds exactly these
 * grants" would lock the owner out of its own tables. Such a script therefore
 * carries only the grants and `extraSql` it was given.
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

  const statements: string[] = ["BEGIN;"];

  // Revoke the privileges the role currently holds, discovered at runtime.
  // Every non-system schema is visited unconditionally (not just ones the
  // role currently has USAGE on) so that privileges surviving under a
  // separately-revoked schema are still caught — REVOKE against a schema the
  // role holds nothing in is a harmless no-op. format(%I) quotes
  // identifiers; the role/owner names are passed as literal parameters to
  // format rather than concatenated into DDL.
  //
  // What is revoked is bounded by what the grant loop below can emit: tables
  // (any privilege), sequences (USAGE, SELECT), and schema USAGE. Schema
  // CREATE and sequence UPDATE are untouched because no grant spec can ask
  // for them back — see the invariant documented on this function.
  //
  // Skipped entirely when the role IS the owner. PostgreSQL records an owner's
  // rights over its own objects as ordinary entries in the object's ACL, and a
  // role is allowed to revoke its own privileges — so running this preamble
  // against the owner strips the owner's access to the very tables it owns
  // (and, via ALTER DEFAULT PRIVILEGES, to tables it has yet to create) until
  // something grants them back. Convergence is also meaningless there: an
  // owner-scoped script exists to run `extraSql`, never to reconcile a grant
  // spec the owner does not have.
  if (role !== owner) {
    const lRole = quoteLiteral(role);
    const lOwner = quoteLiteral(owner);
    const tag = chooseDollarTag([role, owner]);

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
        `    EXECUTE format('REVOKE ${SEQUENCE_PRIVILEGES} ON ALL SEQUENCES IN SCHEMA %I FROM %I', s.nspname, ${lRole});`,
        `    EXECUTE format('REVOKE USAGE ON SCHEMA %I FROM %I', s.nspname, ${lRole});`,
        `    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', ${lOwner}, s.nspname, ${lRole});`,
        `    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ${SEQUENCE_PRIVILEGES} ON SEQUENCES FROM %I', ${lOwner}, s.nspname, ${lRole});`,
        "  END LOOP;",
        "END",
        `$${tag}$;`,
      ].join("\n")
    );
  }

  // Schemas whose sequences have already been granted, so two write grants in
  // the same schema emit the sequence statements once rather than twice.
  const sequenceGrantedSchemas = new Set<string>();

  for (const grant of grants) {
    const normalized = grant.privileges.map(normalizePrivilege);
    const privileges = normalized.join(", ");
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

    // A write grant is useless on a table with a serial/identity column unless
    // the column's sequence is usable too, so the sequences of the grant's
    // schema come with it. They are granted schema-wide even for an
    // object-scoped grant: a sequence is a separate object whose link to its
    // table lives in pg_depend, and this compiler emits static SQL rather than
    // introspecting the catalog. The privileges are the narrow
    // read-and-advance pair, never sequence UPDATE (`setval`).
    if (
      !sequenceGrantedSchemas.has(schema) &&
      normalized.some((privilege) => SEQUENCE_IMPLYING_PRIVILEGES.has(privilege))
    ) {
      sequenceGrantedSchemas.add(schema);
      statements.push(
        `GRANT ${SEQUENCE_PRIVILEGES} ON ALL SEQUENCES IN SCHEMA ${qSchema} TO ${qRole};`
      );
      statements.push(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${qOwner} IN SCHEMA ${qSchema} ` +
          `GRANT ${SEQUENCE_PRIVILEGES} ON SEQUENCES TO ${qRole};`
      );
    }
  }

  statements.push(...extraSql);
  statements.push("COMMIT;");

  return statements.join("\n");
}
