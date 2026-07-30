/**
 * Pure defaults resolution and validation for database role configuration.
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
 * Reject a role name that cannot be safely embedded in a database identifier.
 *
 * This is a choke point, not a per-engine concern. CloudNativePG's grants go
 * through an identifier quoter and MariaDB's go through `Grant` CRs rather than
 * SQL, so neither is exploitable today — but Neo4j interpolates the name
 * directly into a Cypher `CREATE USER` statement between escaped backticks, and
 * one validator all three call is easier to reason about than three separate
 * arguments for why each backend happens to be fine.
 *
 * @param roleName - Role name as it would be created in the engine
 * @param databaseName - Database the role belongs to, for the error message
 * @throws {AnyCloudError} code `UNSUPPORTED_ROLE_OPTION` when the name contains
 *   a backtick, single quote, double quote, backslash, or NUL byte
 */
export function assertValidRoleName(roleName: string, databaseName: string): void {
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
