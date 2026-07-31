/**
 * Constants and naming helpers shared by the MariaDB Operator modules.
 *
 * They live here rather than in any one module because `mariadb.ts` (the
 * MariaDB instance), `mariadb-roles.ts` (users, grants, and credentials), and
 * `mariadb-database.ts` (databases) all need them and none of them owns them.
 *
 * @module operator/mariadb-common
 */

import { createRoleRegistry, type IRoleRegistry } from "./role-registry.js";

/** Namespace every MariaDB instance, database, and credential Secret is created in. */
export const DATA_NAMESPACE = "data";

/** API group and version of every mariadb-operator custom resource. */
export const MARIADB_API_VERSION = "k8s.mariadb.com/v1alpha1";

/** Kind of the custom resource that owns a MariaDB instance. */
export const MARIADB_KIND = "MariaDB";

/** Kind of the custom resource that owns a database. */
export const DATABASE_KIND = "Database";

/** Kind of the custom resource that owns a login account. */
export const USER_KIND = "User";

/** Kind of the custom resource that owns a privilege grant. */
export const GRANT_KIND = "Grant";

/** Kind of the custom resource that owns a scheduled backup. */
export const BACKUP_KIND = "Backup";

/** Host pattern a user may connect from when none is configured. */
export const DEFAULT_GRANT_HOST = "%";

/** Concurrent connection cap applied to every provisioned user. */
export const DEFAULT_MAX_USER_CONNECTIONS = 100;

/** `spec.table` value covering every table in the database. */
export const ALL_TABLES = "*";

/** `IDatabaseGrant.objects` value meaning "every object", not a literal name. */
export const ALL_OBJECTS = "all";

/** Privilege set granted to a database's owner. */
export const ALL_PRIVILEGES = "ALL PRIVILEGES";

/** What a MariaDB account's identity is global to. */
const MARIADB_ROLE_SCOPE_NOUN = "instance";

/** Why a duplicate MariaDB `user`@`host` pair cannot be waved through. */
const MARIADB_ROLE_SCOPE_EXPLANATION =
  "MariaDB accounts are instance-global, not database-scoped: one account serves " +
  "every database on the instance, and its identity is the username and host " +
  "together. Two User CRs naming the same pair would each point at a different " +
  "generated password Secret, and the operator would reconcile the account's " +
  "password back and forth between them, until at least one database's replicated " +
  "connection Secrets stopped authenticating. Their Pulumi logical names differ, so " +
  "`pulumi preview` cannot see the clash.";

/**
 * Create the role-identity registry for one MariaDB instance.
 *
 * @param clusterName - MariaDB instance the registry covers
 * @returns A registry that rejects a `user`@`host` pair claimed twice on this instance
 */
export function createMariadbRoleRegistry(clusterName: string): IRoleRegistry {
  return createRoleRegistry({
    clusterName,
    scopeNoun: MARIADB_ROLE_SCOPE_NOUN,
    scopeExplanation: MARIADB_ROLE_SCOPE_EXPLANATION,
  });
}

/**
 * Claim a MariaDB account on an instance.
 *
 * The claim is keyed on the username **and** the host, because that pair is what
 * MariaDB treats as one account: `reader`@`%` and `reader`@`10.0.0.1` are two
 * separate accounts with separate passwords, so both must be allowed.
 *
 * @param registry - The instance's registry
 * @param roleName - Username as it will exist in MariaDB
 * @param host - Effective host pattern, after {@link DEFAULT_GRANT_HOST} is applied
 * @param dbName - Database whose configuration is claiming it
 * @throws {AnyCloudError} code `UNSUPPORTED_ROLE_OPTION` when the pair is taken
 */
export function claimMariadbRoleName(
  registry: IRoleRegistry,
  roleName: string,
  host: string,
  dbName: string
): void {
  registry.claim({
    // Serialized rather than joined on "@": a role name may itself contain one
    // (the name validator permits it), and `a@b`@`c` must not collide with
    // `a`@`b@c`.
    identity: JSON.stringify([roleName, host]),
    label: `"${roleName}"@"${host}"`,
    databaseName: dbName,
  });
}

/**
 * Normalize a string into a DNS-1123 subdomain usable as `metadata.name`.
 *
 * Only the Kubernetes object name is sanitized — the MariaDB identifiers in
 * `spec.name` / `spec.username` are passed through verbatim so that CRs adopt
 * databases and users that already exist under their original names.
 *
 * @param value - Raw name
 * @returns A lowercase, `-`-separated name safe for `metadata.name`
 */
export function toResourceName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
