/**
 * Constants and naming helpers shared by the MariaDB Operator modules.
 *
 * They live here rather than in any one module because `mariadb.ts` (the
 * MariaDB instance), `mariadb-roles.ts` (users, grants, and credentials), and
 * `mariadb-database.ts` (databases) all need them and none of them owns them.
 *
 * @module operator/mariadb-common
 */

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
