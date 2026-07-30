/**
 * Constants and naming helpers shared by the Neo4j modules.
 *
 * They live here rather than in any one module because `neo4j.ts` (the Helm
 * deployment), `neo4j-roles.ts` (users and their credentials), and
 * `neo4j-database.ts` (databases) all need them and none of them owns them.
 *
 * @module operator/neo4j-common
 */

/** Namespace every Neo4j deployment, Job, and credential Secret is created in. */
export const DATA_NAMESPACE = "data";

/** Bolt protocol port every provisioned client connects on. */
export const NEO4J_BOLT_PORT = 7687;

/** HTTP (Browser / REST) port published in replicated connection Secrets. */
export const NEO4J_HTTP_PORT = 7474;

/** Prometheus metrics port exposed by Neo4j Enterprise. */
export const NEO4J_METRICS_PORT = 2004;

/** Label marking every object the Neo4j modules create as nimbus-managed. */
export const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";

/** Value of {@link MANAGED_BY_LABEL}. */
export const MANAGED_BY_VALUE = "nimbus";

/** Image the user-provisioning Job runs `cypher-shell` from. */
export const CYPHER_SHELL_IMAGE = "neo4j:community";

/** Built-in administrative user the provisioning Job authenticates as. */
export const NEO4J_ADMIN_USER = "neo4j";

/**
 * Normalize a string into a DNS-1123 subdomain usable as `metadata.name`.
 *
 * Only the Kubernetes object name is sanitized — the Neo4j usernames passed to
 * `cypher-shell` go through verbatim so that `CREATE USER ... IF NOT EXISTS`
 * adopts an account that already exists under its original name.
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
