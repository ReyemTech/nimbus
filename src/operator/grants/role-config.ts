/**
 * Pure defaults resolution and validation for database role configuration, and
 * the shared validators every backend runs over caller-supplied identifiers.
 *
 * @module operator/grants/role-config
 */

import { AnyCloudError, ERROR_CODES } from "../../types/errors.js";
import type { IDatabaseGrant, IDatabaseRoleConfig, ReclaimPolicy } from "../interfaces.js";

/** Role configuration with all defaults applied. */
export interface IResolvedRoleConfig {
  readonly login: boolean;
  /**
   * Desired privileges, or `undefined` when nimbus does not manage this role's
   * privileges at all.
   *
   * The distinction is load-bearing and must survive defaults resolution: an
   * empty array means "this role should hold no privileges" and reconciles to
   * a revoke of everything, while `undefined` means "leave the role's
   * privileges alone". Collapsing the two — defaulting to `[]` — would make
   * removing the last grant from a config indistinguishable from never having
   * configured grants, and the role would silently keep every privilege it had.
   */
  readonly grants: ReadonlyArray<IDatabaseGrant> | undefined;
  readonly reclaimPolicy: ReclaimPolicy;
  readonly namespaces: ReadonlyArray<string>;
}

const DEFAULT_LOGIN = true;
const DEFAULT_RECLAIM_POLICY: ReclaimPolicy = "retain";

/**
 * Characters no role name may contain, with a human-readable name for each.
 *
 * Every engine nimbus supports quotes identifiers somehow — PostgreSQL with
 * `"`, MariaDB with `` ` ``, Neo4j Cypher with `` ` `` — and each of these
 * characters terminates or escapes at least one of those quotings. A role name
 * is caller-controlled and flows into generated SQL, into Cypher, and into CR
 * `spec` fields, so it is validated once here rather than argued about three
 * times. NUL is included because it truncates the identifier in C-string
 * consumers rather than being rejected by them.
 */
const FORBIDDEN_ROLE_NAME_CHARS: ReadonlyArray<readonly [string, string]> = [
  ["`", "a backtick"],
  ["'", "a single quote"],
  ['"', "a double quote"],
  ["\\", "a backslash"],
  ["\0", "a NUL byte"],
];

/**
 * Matches a value holding nothing but whitespace, the empty string included.
 *
 * The empty string is not a valid account or database name in PostgreSQL,
 * MariaDB or Neo4j. Whitespace-only strings technically are — every engine
 * quotes identifiers, so `" "` is creatable — but they are refused alongside
 * the empty string because nothing readable derives from them: narrowing one
 * into a Kubernetes name leaves nothing behind, so every resource would be
 * named after a bare hash. A name that renders as nothing is a config typo far
 * more often than it is a deliberate account.
 */
const BLANK_IDENTIFIER = /^\s*$/;

/**
 * Reject a role name that cannot be safely embedded in a database identifier.
 *
 * This is a choke point, not a per-engine concern. CloudNativePG's grants go
 * through an identifier quoter and MariaDB's go through `Grant` CRs rather than
 * SQL, so neither is exploitable today — but Neo4j interpolates the name
 * directly into a Cypher `CREATE USER` statement between escaped backticks, and
 * one validator all three call is easier to reason about than three separate
 * arguments for why each backend happens to be fine.
 *
 * A blank name is refused here for the same reason: accepted, all three backends
 * would register a full set of resources — the CR or Job, the credential Secret,
 * the replicated connection Secrets — and the failure would surface only once
 * the controller or provisioning Job tried to create an account with no name,
 * long after `pulumi up` reported success.
 *
 * @param roleName - Role name as it would be created in the engine
 * @param databaseName - Database the role belongs to, for the error message
 * @throws {AnyCloudError} code `UNSUPPORTED_ROLE_OPTION` when the name is blank,
 *   or contains a backtick, single quote, double quote, backslash, or NUL byte
 */
export function assertValidRoleName(roleName: string, databaseName: string): void {
  if (BLANK_IDENTIFIER.test(roleName)) {
    throw new AnyCloudError(
      `Role name ${JSON.stringify(roleName)} on database "${databaseName}" is empty. ` +
        "PostgreSQL, MariaDB and Neo4j all require an account to have a name, so nothing " +
        "would be provisioned for this role — the failure would surface inside the " +
        "controller or provisioning Job, after the deploy reported success. Pass a " +
        "non-empty role name.",
      ERROR_CODES.UNSUPPORTED_ROLE_OPTION
    );
  }
  for (const [char, label] of FORBIDDEN_ROLE_NAME_CHARS) {
    if (roleName.includes(char)) {
      throw new AnyCloudError(
        `Role name ${JSON.stringify(roleName)} on database "${databaseName}" contains ` +
          `${label}, which cannot be safely embedded in a database identifier. Role names ` +
          "must not contain backticks, quotes, backslashes, or NUL bytes.",
        ERROR_CODES.UNSUPPORTED_ROLE_OPTION
      );
    }
  }
}

/**
 * Reject a database name no engine could create a database under.
 *
 * The same hole as a blank role name, one level up: `createDatabase("")` — or a
 * name resolved from a config value that turned out to be empty — reaches the
 * backends as a database with no name, and every CR, Job and Secret is
 * registered before anything notices. On CloudNativePG and Neo4j the owner
 * defaults to the database name and would be caught by
 * {@link assertValidRoleName}, but only while no explicit `owner` is set, which
 * is exactly the case a caller is most likely to have configured.
 *
 * Only blankness is checked. The character set is not narrowed here: a database
 * name reaches the engine through CR `spec` fields rather than through SQL this
 * library composes, and on every backend it is additionally run through
 * {@link assertValidRoleName} whenever it is also the owner's name.
 *
 * @param databaseName - Database name as it would be created in the engine
 * @throws {AnyCloudError} code `UNSUPPORTED_ROLE_OPTION` when the name is blank
 */
export function assertValidDatabaseName(databaseName: string): void {
  if (BLANK_IDENTIFIER.test(databaseName)) {
    throw new AnyCloudError(
      `Database name ${JSON.stringify(databaseName)} is empty. A database must have a ` +
        "name on every engine nimbus supports, so nothing would be provisioned for it — " +
        "the failure would surface inside the controller or provisioning Job, after the " +
        "deploy reported success. Pass a non-empty database name.",
      ERROR_CODES.UNSUPPORTED_ROLE_OPTION
    );
  }
}

/**
 * Apply defaults to a role config and validate its grants.
 *
 * `grants` is deliberately **not** defaulted: see
 * {@link IResolvedRoleConfig.grants} for why `undefined` and `[]` must stay
 * distinguishable.
 *
 * @param config - Raw user-supplied configuration
 * @returns Configuration with every optional field resolved
 * @throws {AnyCloudError} code `INVALID_GRANT` when a grant lists no privileges
 */
export function resolveRoleConfig(config?: IDatabaseRoleConfig): IResolvedRoleConfig {
  const grants = config?.grants;

  for (const grant of grants ?? []) {
    if (grant.privileges.length === 0) {
      throw new AnyCloudError(
        "Each grant must list at least one privilege.",
        ERROR_CODES.INVALID_GRANT
      );
    }
  }

  return {
    login: config?.login ?? DEFAULT_LOGIN,
    grants,
    reclaimPolicy: config?.reclaimPolicy ?? DEFAULT_RECLAIM_POLICY,
    namespaces: config?.namespaces ?? [],
  };
}
