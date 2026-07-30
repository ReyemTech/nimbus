/**
 * Pure defaults resolution and validation for database role configuration.
 *
 * @module operator/grants/role-config
 */

import { AnyCloudError } from "../../types/errors.js";
import type { IDatabaseGrant, IDatabaseRoleConfig, ReclaimPolicy } from "../interfaces.js";

/** Role configuration with all defaults applied. */
export interface IResolvedRoleConfig {
  readonly login: boolean;
  readonly grants: ReadonlyArray<IDatabaseGrant>;
  readonly reclaimPolicy: ReclaimPolicy;
  readonly namespaces: ReadonlyArray<string>;
}

const DEFAULT_LOGIN = true;
const DEFAULT_RECLAIM_POLICY: ReclaimPolicy = "retain";

/**
 * Apply defaults to a role config and validate its grants.
 *
 * @param config - Raw user-supplied configuration
 * @returns Configuration with every optional field resolved
 * @throws {AnyCloudError} code `INVALID_GRANT` when a grant lists no privileges
 */
export function resolveRoleConfig(config?: IDatabaseRoleConfig): IResolvedRoleConfig {
  const grants = config?.grants ?? [];

  for (const grant of grants) {
    if (grant.privileges.length === 0) {
      throw new AnyCloudError("Each grant must list at least one privilege.", "INVALID_GRANT");
    }
  }

  return {
    login: config?.login ?? DEFAULT_LOGIN,
    grants,
    reclaimPolicy: config?.reclaimPolicy ?? DEFAULT_RECLAIM_POLICY,
    namespaces: config?.namespaces ?? [],
  };
}
