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

/** Privileges accepted in {@link IDatabaseGrant.privileges}. */
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
  "CONNECT",
  "TEMPORARY",
  "EXECUTE",
  "ALL PRIVILEGES",
]);

/** Sentinel meaning "every current and future object in the schema". */
const ALL_OBJECTS = "all";
const DEFAULT_SCHEMA = "public";

/** Options for {@link compileGrantSql}. */
export interface ICompileOptions {
  /** Role receiving the privileges. */
  readonly role: string;
  /** Database owner — the role whose future objects default privileges apply to. */
  readonly owner: string;
  /** Desired grants. An empty list revokes everything the role holds. */
  readonly grants: ReadonlyArray<IDatabaseGrant>;
  /** Raw SQL appended after the grants. Must be idempotent. */
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
 * Compile a grant spec into an idempotent, transactional SQL script.
 *
 * @param options - Role, owner, desired grants, and optional trailing SQL
 * @returns A complete SQL script beginning with `BEGIN;` and ending `COMMIT;`
 * @throws {AnyCloudError} code `UNSUPPORTED_PRIVILEGE` when a privilege is not
 *   in the allowlist
 */
export function compileGrantSql(options: ICompileOptions): string {
  const { role, owner, grants, extraSql = [] } = options;
  const qRole = quoteIdentifier(role);
  const qOwner = quoteIdentifier(owner);
  const lRole = quoteLiteral(role);
  const lOwner = quoteLiteral(owner);

  const statements: string[] = ["BEGIN;"];

  // Revoke every privilege the role currently holds, discovered at runtime.
  // format(%I) quotes identifiers; the role/owner names are passed as literal
  // parameters to has_schema_privilege/format rather than concatenated into DDL.
  statements.push(
    [
      "DO $nimbus$",
      "DECLARE s record;",
      "BEGIN",
      "  FOR s IN",
      "    SELECT nspname FROM pg_namespace",
      "    WHERE nspname NOT LIKE 'pg\\_%'",
      "      AND nspname <> 'information_schema'",
      `      AND has_schema_privilege(${lRole}, nspname, 'USAGE')`,
      "  LOOP",
      `    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', s.nspname, ${lRole});`,
      `    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', s.nspname, ${lRole});`,
      `    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', s.nspname, ${lRole});`,
      `    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', ${lOwner}, s.nspname, ${lRole});`,
      "  END LOOP;",
      "END",
      "$nimbus$;",
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
