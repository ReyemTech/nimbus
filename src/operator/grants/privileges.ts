/**
 * Shared validation for privilege keywords in {@link IDatabaseGrant.privileges}.
 *
 * A privilege is a SQL keyword, not a value: it cannot be quoted or escaped on
 * its way into a `GRANT` statement, so the only defence is to check it against
 * an allowlist before it is emitted. That check is shared, but the allowlist is
 * not — PostgreSQL and MariaDB spell privileges differently and support
 * different sets (`INDEX`, `DROP`, and `EVENT` are MariaDB-only; `TRUNCATE` is
 * PostgreSQL-only). Each engine therefore passes its own set, and neither
 * inherits the other's by accident.
 *
 * @module operator/grants/privileges
 */

import { AnyCloudError, ERROR_CODES } from "../../types/errors.js";

/**
 * Validate and normalise a privilege keyword against one engine's allowlist.
 *
 * @param privilege - Raw privilege name, any case or internal spacing
 * @param allowed - Privileges the engine's grant path can emit, upper-cased
 * @param engine - Engine name for the error message (e.g. "PostgreSQL")
 * @returns The trimmed, upper-cased, single-spaced privilege
 * @throws {AnyCloudError} code `UNSUPPORTED_PRIVILEGE` when not in `allowed`
 */
export function normalizePrivilegeAgainst(
  privilege: string,
  allowed: ReadonlySet<string>,
  engine: string
): string {
  const normalized = privilege.trim().toUpperCase().replace(/\s+/g, " ");
  if (!allowed.has(normalized)) {
    throw new AnyCloudError(
      `Unsupported privilege "${privilege}" for ${engine}. ` +
        `Allowed: ${[...allowed].join(", ")}.`,
      ERROR_CODES.UNSUPPORTED_PRIVILEGE
    );
  }
  return normalized;
}
