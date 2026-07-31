/**
 * Constants and naming helpers shared by the Neo4j modules.
 *
 * They live here rather than in any one module because `neo4j.ts` (the Helm
 * deployment), `neo4j-roles.ts` (users and their credentials), and
 * `neo4j-database.ts` (databases) all need them and none of them owns them.
 *
 * @module operator/neo4j-common
 */

import { createRoleRegistry, type IRoleRegistry } from "./role-registry.js";

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

/** What a Neo4j username's identity is global to. */
const NEO4J_ROLE_SCOPE_NOUN = "deployment";

/** Why a duplicate Neo4j username cannot be waved through. */
const NEO4J_ROLE_SCOPE_EXPLANATION =
  "Neo4j users are deployment-global, not database-scoped: one account serves every " +
  "database on the deployment. Each nimbus role provisions its own cypher-shell Job " +
  "and its own generated password Secret, and `CREATE USER ... IF NOT EXISTS` makes " +
  "whichever Job runs second a silent no-op — the account keeps the first password " +
  "while the second role's replicated connection Secrets hold one that was never set " +
  "and can never authenticate. Their Pulumi logical names differ, so `pulumi preview` " +
  "cannot see the clash, and neither Job reports a failure.";

/**
 * Create the username registry for one Neo4j deployment.
 *
 * @param clusterName - Neo4j deployment the registry covers
 * @returns A registry that rejects a username claimed twice on this deployment
 */
export function createNeo4jRoleRegistry(clusterName: string): IRoleRegistry {
  return createRoleRegistry({
    clusterName,
    scopeNoun: NEO4J_ROLE_SCOPE_NOUN,
    scopeExplanation: NEO4J_ROLE_SCOPE_EXPLANATION,
  });
}

/**
 * Claim a Neo4j username on a deployment.
 *
 * A Neo4j account's identity is its username and nothing else — there is no
 * host component as on MariaDB — so the claim key and its display form differ
 * only in quoting.
 *
 * @param registry - The deployment's registry
 * @param roleName - Username as it will exist in Neo4j
 * @param dbName - Database whose configuration is claiming it
 * @throws {AnyCloudError} code `UNSUPPORTED_ROLE_OPTION` when the name is taken
 */
export function claimNeo4jUsername(
  registry: IRoleRegistry,
  roleName: string,
  dbName: string
): void {
  registry.claim({ identity: roleName, label: `"${roleName}"`, databaseName: dbName });
}

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
