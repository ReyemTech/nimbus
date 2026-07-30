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
 * `grants` and `login: false` both throw.
 *
 * @module operator/neo4j-database
 */

import type * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { MANAGED_BY_LABEL, MANAGED_BY_VALUE } from "./neo4j-common.js";
import {
  additionalRoleNaming,
  ownerRoleNaming,
  provisionNeo4jRole,
  replicateNeo4jConnectionSecrets,
} from "./neo4j-roles.js";
import { resolveRoleConfig } from "./grants/role-config.js";
import { AnyCloudError, ERROR_CODES } from "../types/errors.js";
import type {
  IDatabaseInstance,
  IDatabaseRole,
  IDatabaseRoleConfig,
  IOperatorDatabaseConfig,
} from "./interfaces.js";

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
 * @throws {AnyCloudError} code `UNSUPPORTED_ROLE_OPTION` when `addRole()` is
 *   called with the database owner's own name, is passed `grants` (Neo4j
 *   Community has no RBAC), or is passed `login: false`
 */
export function createSingleNeo4jDatabaseInstance(
  options: INeo4jDatabaseOptions
): IDatabaseInstance {
  const { clusterName, dbName, config, endpoint, port, adminSecretName, release, provider } =
    options;

  const username = config.owner ?? dbName;
  const labels = {
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    "nimbus/cluster": clusterName,
    "nimbus/database": dbName,
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
    podLabels: { "nimbus/database": dbName },
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
      if (resolved.grants.length > 0) {
        throw new AnyCloudError(
          `Neo4j does not support declarative grants (role "${roleName}" on "${dbName}"). ` +
            `Neo4j Community has no RBAC; remove the grants option.`,
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

      const naming = additionalRoleNaming(clusterName, dbName, roleName);
      const roleLabels = { ...labels, "nimbus/role": roleName };

      const provisioned = provisionNeo4jRole({
        dbName,
        roleName,
        naming,
        adminSecretName,
        endpoint,
        labels: roleLabels,
        podLabels: { "nimbus/database": dbName, "nimbus/role": roleName },
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
