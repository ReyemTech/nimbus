/**
 * Databases inside a Neo4j deployment.
 *
 * Neo4j is provisioned imperatively, unlike the other two backends. There is no
 * operator and no CRDs: the Helm chart deploys the instance directly and each
 * user is created by a one-shot `cypher-shell` Job. The uniformity `addRole()`
 * provides here is at the API level, not the mechanism level — the same call
 * shape and the same `IDatabaseRole` come back, but nothing reconciles the
 * account afterwards, and there are no privileges to reconcile in the first
 * place because `neo4j:community` has no RBAC.
 *
 * Everything that RBAC would express is therefore refused rather than ignored:
 * `grants` and `login: false` both throw. So does `config.sql` — the only
 * statements this backend can run are the Cypher its provisioning Job carries.
 *
 * Usernames are deployment-global here as they are cluster-global on the other
 * two backends, so a per-deployment {@link IRoleRegistry} refuses a name claimed
 * twice. Neo4j's failure mode is quieter than theirs: `CREATE USER ... IF NOT
 * EXISTS` does not fight over the password, it simply does nothing, leaving the
 * losing role's replicated Secrets holding a credential that never existed.
 *
 * @module operator/neo4j-database
 */

import type * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE, claimNeo4jUsername } from "./neo4j-common.js";
import {
  additionalRoleNaming,
  ownerRoleNaming,
  provisionNeo4jRole,
  replicateNeo4jConnectionSecrets,
} from "./neo4j-roles.js";
import { assertValidRoleName, resolveRoleConfig } from "./grants/role-config.js";
import { toLabelValue } from "./resource-identity.js";
import { ENGINE_NAMES, assertNoForeignEngineOptions, assertNoSql } from "./database-options.js";
import { AnyCloudError, ERROR_CODES } from "../types/errors.js";
import type { IRoleRegistry } from "./role-registry.js";
import type {
  IDatabaseInstance,
  IDatabaseRole,
  IDatabaseRoleConfig,
  IOperatorDatabaseConfig,
} from "./interfaces.js";

/** Engine name used in errors about options Neo4j cannot honour. */
const NEO4J_ENGINE_NAME = ENGINE_NAMES.NEO4J;

/** Label naming the deployment an object belongs to. */
const CLUSTER_LABEL = "nimbus/cluster";
/** Label naming the database an object belongs to. */
const DATABASE_LABEL = "nimbus/database";
/**
 * Label naming the role an object belongs to.
 *
 * Its value is a sanitized form of the username — see {@link toLabelValue} —
 * because label values accept far less than a Neo4j username does.
 */
const ROLE_LABEL = "nimbus/role";

/**
 * Reject `environments`, which Neo4j cannot fan a database out across.
 *
 * CNPG and MariaDB create one database per environment named `{db}-{env}` and
 * return a Record of them. Neo4j Community allows a single user database, so
 * there is nothing to fan out. The option used to be accepted and silently
 * dropped, which returned one instance where the caller's types promised a
 * Record — leaving `db["prod"]` undefined at runtime with nothing to explain it.
 *
 * @param dbName - Database the configuration belongs to
 * @param config - Raw per-database configuration
 * @throws {AnyCloudError} code `UNSUPPORTED_ROLE_OPTION` when `environments` is set
 */
export function assertNoEnvironments(dbName: string, config: IOperatorDatabaseConfig): void {
  if (config.environments) {
    throw new AnyCloudError(
      `Database "${dbName}" cannot use "environments" on Neo4j — the Community edition ` +
        "allows a single user database, so there is nothing to fan out. Create one Neo4j " +
        "cluster per environment instead.",
      ERROR_CODES.UNSUPPORTED_ROLE_OPTION
    );
  }
}

/** Inputs for {@link createSingleNeo4jDatabaseInstance}. */
export interface INeo4jDatabaseOptions {
  /** Neo4j deployment the database belongs to. */
  readonly clusterName: string;
  /** Database name, passed to Neo4j verbatim. */
  readonly dbName: string;
  /** Per-database configuration, with environments already resolved away. */
  readonly config: Omit<IOperatorDatabaseConfig, "environments">;
  /** Deployment endpoint. */
  readonly endpoint: pulumi.Output<string>;
  /** Deployment Bolt port. */
  readonly port: pulumi.Output<number>;
  /** Kubernetes name of the Secret holding the built-in `neo4j` password. */
  readonly adminSecretName: string;
  /** The Helm release the deployment comes from. */
  readonly release: k8s.helm.v3.Release;
  /**
   * Usernames already claimed on this deployment, shared by every database on
   * it.
   *
   * Neo4j users are deployment-global, so this cannot be per-database: see
   * {@link IRoleRegistry}.
   */
  readonly roleRegistry: IRoleRegistry;
  /** Kubernetes provider. */
  readonly provider: k8s.Provider;
}

/**
 * Create a single database instance within a Neo4j deployment.
 *
 * The owner's account is created by a `cypher-shell` Job and its connection
 * details are replicated into the configured namespaces. Additional users are
 * added afterwards via the returned `addRole()`.
 *
 * @param options - Deployment, database name, configuration, and provider
 * @returns The database instance, with `addRole()` bound to it
 * @throws {AnyCloudError} code `INVALID_GRANT` when a role's grant lists no privileges
 * @throws {AnyCloudError} code `UNSUPPORTED_ROLE_OPTION` when `config.sql` is
 *   set (Neo4j runs no SQL), or when `addRole()` is called with the database
 *   owner's own name, with a username any other database on the same deployment
 *   has already claimed, is passed `grants` (Neo4j Community has no RBAC), is
 *   passed `login: false`, or is passed any `engineOptions` block
 */
export function createSingleNeo4jDatabaseInstance(
  options: INeo4jDatabaseOptions
): IDatabaseInstance {
  const { clusterName, dbName, config, endpoint, port, adminSecretName, release, provider } =
    options;
  const { roleRegistry } = options;

  // The provisioning Job speaks Cypher, not SQL, and there is no second Job to
  // put statements in — so `sql` is refused rather than dropped on the floor.
  assertNoSql(dbName, config, NEO4J_ENGINE_NAME);

  const username = config.owner ?? dbName;
  assertValidRoleName(username, dbName);
  // The owner is a deployment-global user like any other, so it claims its name
  // too — otherwise a later addRole() on a *different* database could take it,
  // and its Job would no-op against this account.
  claimNeo4jUsername(roleRegistry, username, dbName);
  const labels = {
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    [CLUSTER_LABEL]: clusterName,
    [DATABASE_LABEL]: dbName,
  };

  const ownerNaming = ownerRoleNaming(clusterName, dbName);
  const ownerConfig = resolveRoleConfig({ namespaces: config.namespaces, login: true });

  const owner = provisionNeo4jRole({
    dbName,
    roleName: username,
    naming: ownerNaming,
    adminSecretName,
    endpoint,
    labels,
    podLabels: { [DATABASE_LABEL]: dbName },
    provider,
    dependsOn: [release],
  });

  const secrets = replicateNeo4jConnectionSecrets({
    naming: ownerNaming,
    namespaces: ownerConfig.namespaces,
    dbName,
    username,
    password: owner.credentials.stablePassword,
    endpoint,
    labels,
    provider,
    dependsOn: [owner.initJob],
  });

  return {
    name: dbName,
    clusterName,
    host: endpoint,
    port,
    database: pulumi.output(dbName),
    secrets,
    nativeResource: owner.initJob,

    addRole(roleName: string, roleConfig?: IDatabaseRoleConfig): IDatabaseRole {
      // The name lands between escaped backticks in the Job's Cypher
      // `CREATE USER` statement, so a backtick in it would break out of the
      // identifier quoting.
      assertValidRoleName(roleName, dbName);

      // The owner's account is already created by createDatabase(). Adding it
      // again would create a SECOND Job issuing `CREATE USER ... IF NOT EXISTS`
      // for the same username, bound to a different password Secret. `IF NOT
      // EXISTS` makes that Job a silent no-op, so the owner's replicated
      // connection Secrets would keep working while this role's Secrets would
      // hold a password that was never set — credentials that simply never
      // authenticate, with nothing in the Pulumi diff to say why.
      if (roleName === username) {
        throw new AnyCloudError(
          `Role "${roleName}" is the owner of database "${dbName}" and is created by ` +
            `createDatabase(); it cannot be added again. Use a different role name, or ` +
            `change the database's "owner".`,
          ERROR_CODES.UNSUPPORTED_ROLE_OPTION
        );
      }

      const resolved = resolveRoleConfig(roleConfig);

      // Neo4j Community has no RBAC — no roles, no privileges, no GRANT. There
      // is nothing to compile these into, and accepting them so the call
      // succeeds would hand back a user with full access to the whole graph
      // while the config says it is read-only.
      //
      // An empty list is refused for the same reason rather than waved through
      // as "nothing to grant". On the engines that model privileges it means
      // "this role should hold none", and Neo4j Community cannot express that
      // either: every account it creates can read and write the whole graph.
      // Only omitting `grants` — asking nimbus not to manage privileges — is
      // honourable here.
      if (resolved.grants !== undefined) {
        throw new AnyCloudError(
          `Neo4j does not support declarative grants (role "${roleName}" on "${dbName}"). ` +
            `Neo4j Community has no RBAC — every account can read and write the whole ` +
            `graph, so even "grants: []" cannot be honoured. Remove the grants option.`,
          ERROR_CODES.UNSUPPORTED_ROLE_OPTION
        );
      }

      // Every Neo4j user is a login account — `CREATE USER` has no non-login
      // form. Honouring `login: false` by ignoring it would hand back a role
      // that can log in when the caller asked for one that cannot.
      if (!resolved.login) {
        throw new AnyCloudError(
          `Role "${roleName}" cannot be created with login: false on Neo4j — every ` +
            `Neo4j user is a login account. Omit "login", or do not create the user.`,
          ERROR_CODES.UNSUPPORTED_ROLE_OPTION
        );
      }

      // Neo4j reads no engineOptions block at all: it has no operator and no
      // CRs, and nothing in `postgresql` or `mariadb` maps onto `CREATE USER`.
      // Either block names an engine that will never run this role.
      assertNoForeignEngineOptions({
        roleName,
        databaseName: dbName,
        engineOptions: roleConfig?.engineOptions,
        engine: NEO4J_ENGINE_NAME,
      });

      // Same hazard one scope wider: the check above only sees this database's
      // own owner, while a user of this name may already belong to a sibling
      // database on the same deployment — the same account, since Neo4j users
      // are deployment-global. Two Jobs then issue `CREATE USER ... IF NOT
      // EXISTS` for it, the second no-ops, and its role's Secrets hold a
      // password that was never set. The registry is what notices.
      //
      // Claimed here rather than at the top of the method so that a call
      // rejected by one of the guards above leaves no claim behind — the role
      // was never provisioned, so its name must stay available.
      claimNeo4jUsername(roleRegistry, roleName, dbName);

      const naming = additionalRoleNaming(clusterName, dbName, roleName);

      // The label carries a sanitized form of the username, never the raw one.
      // The shared validator deliberately permits `reporting@corp`, and `@` is
      // not a legal label character — the Kubernetes API rejects the whole
      // object at apply time, after preview has passed, so the Job carrying the
      // label never runs and the account is never created. The raw name still
      // goes verbatim into the Cypher statement and the Secret payload, which
      // are the two places it must be exact.
      const roleLabel = toLabelValue(roleName);
      const roleLabels = { ...labels, [ROLE_LABEL]: roleLabel };

      const provisioned = provisionNeo4jRole({
        dbName,
        roleName,
        naming,
        adminSecretName,
        endpoint,
        labels: roleLabels,
        podLabels: { [DATABASE_LABEL]: dbName, [ROLE_LABEL]: roleLabel },
        provider,
        dependsOn: [release],
      });

      // The connection Secret waits on the Job so a consumer cannot read
      // credentials and connect before the account exists.
      const roleSecrets = replicateNeo4jConnectionSecrets({
        naming,
        namespaces: resolved.namespaces,
        dbName,
        username: roleName,
        password: provisioned.credentials.stablePassword,
        endpoint,
        labels: roleLabels,
        provider,
        dependsOn: [provisioned.initJob],
      });

      return {
        name: roleName,
        databaseName: dbName,
        clusterName,
        secrets: roleSecrets,
        nativeResource: provisioned.initJob,
      };
    },
  };
}
