/**
 * Constants and naming helpers shared by the CloudNativePG modules.
 *
 * They live here rather than in any one module because `cnpg.ts` (the Cluster),
 * `cnpg-roles.ts` (roles and their credentials), and `cnpg-database.ts`
 * (databases) all need them and none of them owns them.
 *
 * @module operator/cnpg-common
 */

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

/**
 * Normalize a string into a DNS-1123 subdomain usable as `metadata.name`.
 *
 * Only the Kubernetes object name is sanitized — the PostgreSQL identifiers in
 * `spec.name` / `spec.owner` are passed through verbatim so that CRs adopt
 * databases and roles that already exist under their original names.
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
