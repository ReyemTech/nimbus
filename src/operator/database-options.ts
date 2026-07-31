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
 * That covers `engineOptions` too: a block addressed to one engine is refused
 * by every other engine rather than ignored. See
 * {@link assertNoForeignEngineOptions}.
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
import type { IDatabaseRoleConfig, IOperatorDatabaseConfig } from "./interfaces.js";

/**
 * Display names for the engines nimbus provisions databases on.
 *
 * Shared so that an error message naming one engine and a guard keyed on
 * another cannot drift apart.
 */
export const ENGINE_NAMES = {
  /** CloudNativePG, the PostgreSQL operator. */
  CNPG: "CloudNativePG",
  /** mariadb-operator. */
  MARIADB: "MariaDB",
  /** Neo4j Community, provisioned by Helm and a `cypher-shell` Job. */
  NEO4J: "Neo4j",
} as const;

/**
 * Name of one `engineOptions` block.
 *
 * Derived from {@link IDatabaseRoleConfig} rather than restated, so adding a
 * block to the public surface without teaching {@link ENGINE_OPTION_OWNERS} who
 * honours it is a compile error rather than a silently unguarded option.
 */
export type EngineOptionBlock = keyof NonNullable<IDatabaseRoleConfig["engineOptions"]>;

/** The one engine that honours each `engineOptions` block. */
const ENGINE_OPTION_OWNERS: Readonly<Record<EngineOptionBlock, string>> = {
  postgresql: ENGINE_NAMES.CNPG,
  mariadb: ENGINE_NAMES.MARIADB,
};

/** Inputs for {@link assertNoForeignEngineOptions}. */
export interface IForeignEngineOptionsCheck {
  /** Role the configuration belongs to. */
  readonly roleName: string;
  /** Database the role is being added to. */
  readonly databaseName: string;
  /** Raw `engineOptions` from the role configuration, if any. */
  readonly engineOptions?: IDatabaseRoleConfig["engineOptions"];
  /**
   * The block this engine reads, or omitted when it reads none.
   *
   * Neo4j honours no block at all: it has no operator, no CRs, and nothing in
   * `postgresql` or `mariadb` maps onto `CREATE USER`.
   */
  readonly honoured?: EngineOptionBlock;
  /** Engine name as it appears in the error message; see {@link ENGINE_NAMES}. */
  readonly engine: string;
}

/**
 * Reject an `engineOptions` block belonging to a different engine.
 *
 * `engineOptions` is one object carrying a block per engine, so nothing in the
 * type system stops a CloudNativePG role from being handed
 * `engineOptions.mariadb`. Such a role provisioned successfully with the
 * requested host, connection cap, memberships or expiry simply absent — the
 * exact silent-drop this module exists to prevent, and the more misleading for
 * looking deliberate: the caller named an engine, and a *different* engine
 * accepted it.
 *
 * Presence is what is checked, not content: an empty `{}` block still names an
 * engine that will not run this role.
 *
 * @param check - Role, database, raw options, and which block this engine reads
 * @throws {AnyCloudError} code `UNSUPPORTED_ROLE_OPTION` when a block for any
 *   other engine is present
 */
export function assertNoForeignEngineOptions(check: IForeignEngineOptionsCheck): void {
  const { roleName, databaseName, engineOptions, honoured, engine } = check;
  if (!engineOptions) {
    return;
  }

  for (const block of Object.keys(ENGINE_OPTION_OWNERS) as EngineOptionBlock[]) {
    if (block === honoured || engineOptions[block] === undefined) {
      continue;
    }
    const owner = ENGINE_OPTION_OWNERS[block];
    const alternative =
      honoured === undefined
        ? `${engine} honours no engineOptions block at all`
        : `on ${engine} only "engineOptions.${honoured}" is honoured`;
    throw new AnyCloudError(
      `Role "${roleName}" on database "${databaseName}" sets ` +
        `"engineOptions.${block}", which only ${owner} honours — ${alternative}, so every ` +
        `option in that block would be silently dropped and the role provisioned without ` +
        `the behaviour the config asks for. Remove "engineOptions.${block}", or add this ` +
        `role to a ${owner} database instead.`,
      ERROR_CODES.UNSUPPORTED_ROLE_OPTION
    );
  }
}

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
