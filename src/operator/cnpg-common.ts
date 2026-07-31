/**
 * Constants and naming helpers shared by the CloudNativePG modules.
 *
 * They live here rather than in any one module because `cnpg.ts` (the Cluster),
 * `cnpg-roles.ts` (roles and their credentials), and `cnpg-database.ts`
 * (databases) all need them and none of them owns them.
 *
 * @module operator/cnpg-common
 */

import { createRoleRegistry, type IRoleRegistry } from "./role-registry.js";
import { toDnsSegment } from "./resource-identity.js";

/** Namespace every CNPG cluster, database, and credential Secret is created in. */
export const DATA_NAMESPACE = "data";

/** PostgreSQL major version used when a cluster does not pin one. */
export const DEFAULT_PG_VERSION = "17";

/** API group and version of every CloudNativePG custom resource. */
export const CNPG_API_VERSION = "postgresql.cnpg.io/v1";

/** Kind of the CNPG custom resource that owns a database. */
export const DATABASE_KIND = "Database";

/** Kind of the CNPG custom resource that owns a login role. */
export const DATABASE_ROLE_KIND = "DatabaseRole";

/** `spec.ensure` value asserting the object must exist. */
export const ENSURE_PRESENT = "present";

/** What a CNPG role's identity is global to. */
const CNPG_ROLE_SCOPE_NOUN = "cluster";

/** Why a duplicate CNPG role name cannot be waved through. */
const CNPG_ROLE_SCOPE_EXPLANATION =
  "PostgreSQL roles are cluster-global, not database-scoped: one role serves every " +
  "database in the cluster. Two DatabaseRole CRs naming it would each point at a " +
  "different generated password Secret, and the operator would rewrite the role's " +
  "password back and forth between them on every reconcile, until at least one " +
  "database's replicated connection Secrets stopped authenticating. Their Pulumi " +
  "logical names differ, so `pulumi preview` cannot see the clash.";

/**
 * Create the role-name registry for one CNPG cluster.
 *
 * @param clusterName - CNPG cluster the registry covers
 * @returns A registry that rejects a role name claimed twice on this cluster
 */
export function createCnpgRoleRegistry(clusterName: string): IRoleRegistry {
  return createRoleRegistry({
    clusterName,
    scopeNoun: CNPG_ROLE_SCOPE_NOUN,
    scopeExplanation: CNPG_ROLE_SCOPE_EXPLANATION,
  });
}

/**
 * Claim a PostgreSQL role name on a cluster.
 *
 * A role's identity in PostgreSQL is its name and nothing else, so the claim key
 * and its display form differ only in quoting.
 *
 * @param registry - The cluster's registry
 * @param roleName - Role name as it will exist in PostgreSQL
 * @param dbName - Database whose configuration is claiming it
 * @throws {AnyCloudError} code `UNSUPPORTED_ROLE_OPTION` when the name is taken
 */
export function claimCnpgRoleName(registry: IRoleRegistry, roleName: string, dbName: string): void {
  registry.claim({ identity: roleName, label: `"${roleName}"`, databaseName: dbName });
}

/**
 * Normalize a string into a DNS-1123 subdomain usable as `metadata.name`.
 *
 * Only the Kubernetes object name is sanitized — the PostgreSQL identifiers in
 * `spec.name` / `spec.owner` are passed through verbatim so that CRs adopt
 * databases and roles that already exist under their original names.
 *
 * Sanitizing is lossy, so this is not safe for anything that has to identify a
 * resource: see {@link toIdentitySegment}.
 *
 * @param value - Raw name
 * @returns A lowercase, `-`-separated name safe for `metadata.name`
 */
export function toResourceName(value: string): string {
  return toDnsSegment(value);
}
