/**
 * Guards for {@link IOperatorDatabaseConfig} options an engine cannot honour.
 *
 * The rule this module exists to enforce is the one the rest of the operator
 * module already follows for `owner`, `login: false`, `environments`, and
 * `grants`: an option that cannot be honoured is refused at preview, never
 * accepted and dropped. A silently ignored option is the worst outcome
 * available — the config says one thing, the database does another, and
 * nothing in the Pulumi diff explains the gap.
 *
 * @module operator/database-options
 */

import { AnyCloudError, ERROR_CODES } from "../types/errors.js";
import type { IOperatorDatabaseConfig } from "./interfaces.js";

/**
 * Reject `config.sql` on an engine with no path for applying raw SQL.
 *
 * Only CloudNativePG has one: its grant-reconciliation Job already runs `psql`
 * as the database owner, so `sql` rides along in that Job. MariaDB provisions
 * everything through `Database`/`User`/`Grant` CRs and Neo4j through a
 * `cypher-shell` Job that speaks Cypher — neither has anywhere to put a
 * PostgreSQL-flavoured statement list, so the statements would simply never run.
 *
 * @param dbName - Database the configuration belongs to
 * @param config - Raw per-database configuration
 * @param engine - Engine name as it appears in the error message (e.g. "MariaDB")
 * @throws {AnyCloudError} code `UNSUPPORTED_ROLE_OPTION` when `sql` is set
 */
export function assertNoSql(
  dbName: string,
  config: Pick<IOperatorDatabaseConfig, "sql">,
  engine: string
): void {
  if (config.sql !== undefined) {
    throw new AnyCloudError(
      `Database "${dbName}" cannot use "sql" on ${engine} — raw SQL is applied only on ` +
        `CloudNativePG, by the same owner-authenticated psql Job that reconciles grants. ` +
        `${engine} has no equivalent path, so the statements would never run. Remove "sql" ` +
        "and apply the statements from an application migration instead.",
      ERROR_CODES.UNSUPPORTED_ROLE_OPTION
    );
  }
}
