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
 * ## The one deliberate exception: `reclaimPolicy`
 *
 * `reclaimPolicy` is accepted on MariaDB and Neo4j and does nothing there. That
 * is inconsistent with the rule above and is documented rather than fixed,
 * because the rule cannot be applied to it:
 *
 * - **It is defaulted, so it is always "set".** `resolveRoleConfig` fills in
 *   `"retain"` when the caller omits it, so by the time any engine could check,
 *   there is no way to tell "the user asked for retain" from "the user said
 *   nothing". A guard would therefore have to reject every MariaDB and Neo4j
 *   database ever declared, including the ones already running. The guards this
 *   module does implement all cover options that are genuinely absent by
 *   default (`sql` is `undefined` unless asked for).
 * - **Only CloudNativePG consumes it.** It becomes
 *   `Database.spec.databaseReclaimPolicy` and
 *   `DatabaseRole.spec.databaseRoleReclaimPolicy`. mariadb-operator's nearest
 *   equivalent is `spec.cleanupPolicy` on its `Database`/`User`/`Grant` CRs, and
 *   Neo4j is provisioned by a `cypher-shell` Job with no CR lifecycle at all.
 * - **Adopting the MariaDB equivalent is not a documentation change.** Setting
 *   `cleanupPolicy` on the CRs of databases that already exist would change
 *   their deletion semantics on the next apply — a data-loss-shaped change made
 *   silently, which is worse than the gap it closes.
 *
 * So on MariaDB and Neo4j the lifecycle of a database, user, or grant is
 * governed by the operator's own default (mariadb-operator retains its managed
 * objects unless `cleanupPolicy` says otherwise; Neo4j has no such notion),
 * not by this field. Nothing is deleted that would otherwise be kept — the
 * exemption costs an unhonoured option, never data.
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
