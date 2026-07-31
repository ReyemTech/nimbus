/**
 * Databases inside a MariaDB Operator instance.
 *
 * Provisioning is fully declarative: a `Database` CR owns the database, a
 * `User` CR owns each login account and its password, and a `Grant` CR owns
 * each privilege set. Unlike CloudNativePG — where privileges have no CRD
 * equivalent and are applied by a `psql` Job — nothing here executes SQL, which
 * is also why `config.sql` throws rather than being dropped. The operator
 * reconciles all three kinds continuously, so drift is corrected rather than
 * silently persisting.
 *
 * @module operator/mariadb-database
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  DATABASE_KIND,
  DATA_NAMESPACE,
  DEFAULT_GRANT_HOST,
  MARIADB_API_VERSION,
  claimMariadbRoleName,
} from "./mariadb-common.js";
import {
  OWNER_GRANT,
  additionalRoleNaming,
  ownerRoleNaming,
  provisionMariadbRole,
  replicateMariadbConnectionSecrets,
  toMariadbGrants,
} from "./mariadb-roles.js";
import {
  assertValidDatabaseName,
  assertValidRoleName,
  resolveRoleConfig,
} from "./grants/role-config.js";
import { ENGINE_NAMES, assertNoForeignEngineOptions, assertNoSql } from "./database-options.js";
import { AnyCloudError, ERROR_CODES } from "../types/errors.js";
import type { IRoleRegistry } from "./role-registry.js";
import type {
  IDatabaseInstance,
  IDatabaseRole,
  IDatabaseRoleConfig,
  IOperatorDatabaseConfig,
} from "./interfaces.js";

/** Label marking every object this module creates as nimbus-managed. */
const MANAGED_BY_LABEL = "app.kubernetes.io/managed-by";
/** Value of {@link MANAGED_BY_LABEL}. */
const MANAGED_BY_VALUE = "nimbus";
/** Character set every provisioned database is created with. */
const DEFAULT_CHARACTER_SET = "utf8mb4";
/** Collation every provisioned database is created with. */
const DEFAULT_COLLATION = "utf8mb4_unicode_ci";
/** Field of the `Database` CR that mariadb-operator rejects updates to. */
const DATABASE_IMMUTABLE_FIELDS = ["spec.name"];
/** Engine name used in errors about options MariaDB cannot honour. */
const MARIADB_ENGINE_NAME = ENGINE_NAMES.MARIADB;

/** Inputs for {@link createSingleMariadbDatabaseInstance}. */
export interface IMariadbDatabaseOptions {
  /** MariaDB instance the database is created on. */
  readonly clusterName: string;
  /** Database name, passed to MariaDB verbatim. */
  readonly dbName: string;
  /** Per-database configuration, with environments already resolved away. */
  readonly config: Omit<IOperatorDatabaseConfig, "environments">;
  /** Instance endpoint. */
  readonly endpoint: pulumi.Output<string>;
  /** Instance port. */
  readonly port: pulumi.Output<number>;
  /** The `MariaDB` CR. */
  readonly mariadb: k8s.apiextensions.CustomResource;
  /**
   * Account identities already claimed on this instance, shared by every
   * database on it.
   *
   * MariaDB accounts are instance-global, so this cannot be per-database: see
   * {@link IRoleRegistry}.
   */
  readonly roleRegistry: IRoleRegistry;
  /** Kubernetes provider. */
  readonly provider: k8s.Provider;
}

/**
 * Create a single database instance within a MariaDB instance.
 *
 * The owner is granted `ALL PRIVILEGES` on the database with `GRANT OPTION`,
 * and its connection details are replicated into the configured namespaces.
 * Additional roles are added afterwards via the returned `addRole()`.
 *
 * @param options - Instance, database name, configuration, and provider
 * @returns The database instance, with `addRole()` bound to it
 * @throws {AnyCloudError} code `INVALID_GRANT` when a role's grant lists no privileges
 * @throws {AnyCloudError} code `UNSUPPORTED_PRIVILEGE` when a role's grant names
 *   a privilege a database-scoped MariaDB `GRANT` cannot carry
 * @throws {AnyCloudError} code `UNSUPPORTED_ROLE_OPTION` when `dbName` is blank
 *   or `addRole()` is called with a blank name, when `config.sql` is
 *   set (MariaDB runs no SQL), when `config.owner` is set to anything but the
 *   database name, when `addRole()` is called with the database owner's own
 *   name, when `addRole()` is called with a `user`@`host` pair any other
 *   database on the same instance has already claimed, when `addRole()` is
 *   passed `login: false`, or when it is passed an `engineOptions` block
 *   belonging to another engine
 */
export function createSingleMariadbDatabaseInstance(
  options: IMariadbDatabaseOptions
): IDatabaseInstance {
  const { clusterName, dbName, config, endpoint, port, mariadb, provider } = options;
  const { roleRegistry } = options;

  assertValidDatabaseName(dbName);

  // Nothing here executes SQL — provisioning is CRs all the way down — so
  // `sql` is refused rather than dropped on the floor.
  assertNoSql(dbName, config, MARIADB_ENGINE_NAME);

  // MariaDB cannot honour `owner`, and rejects it rather than ignoring it.
  //
  // The live `User` and `Grant` CRs carry `ignoreChanges` on `spec.name` /
  // `spec.username` because mariadb-operator's webhook refuses updates to them.
  // `ignoreChanges` suppresses diffs only on resources that already exist, so
  // honouring `owner` would in fact work on a greenfield stack and break only on
  // upgrade: the existing account would stay named after the database while
  // `username` and `uri` flipped in every already-replicated connection Secret,
  // leaving applications authenticating as a user that was never created. An
  // option whose correctness depends on how old the stack is, is worse than one
  // that is refused outright — so this fails at preview, before anything is
  // registered. The owner's username is always the database name.
  if (config.owner !== undefined && config.owner !== dbName) {
    throw new AnyCloudError(
      `Database "${dbName}" cannot set owner "${config.owner}" on MariaDB — the owner is ` +
        `always the database name. mariadb-operator treats User.spec.name and ` +
        `Grant.spec.username as immutable, so an owner that differs would rename only the ` +
        `replicated connection Secrets. Remove "owner", or use addRole("${config.owner}") ` +
        `to create it as an additional role.`,
      ERROR_CODES.UNSUPPORTED_ROLE_OPTION
    );
  }
  const username = dbName;
  assertValidRoleName(username, dbName);
  // The owner's CRs omit `spec.host` and rely on the operator's own default,
  // which is DEFAULT_GRANT_HOST — so that is the host its account effectively
  // has, and the host it must claim. Claiming it matters because a later
  // addRole() on a *different* database could otherwise take the same pair.
  claimMariadbRoleName(roleRegistry, username, DEFAULT_GRANT_HOST, dbName);
  const labels = {
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    "nimbus/cluster": clusterName,
    "nimbus/database": dbName,
  };

  const ownerNaming = ownerRoleNaming(clusterName, dbName);
  const ownerConfig = resolveRoleConfig({ namespaces: config.namespaces, login: true });

  // Database CR: owns the database itself. `spec.name` is the raw MariaDB
  // identifier so the CR adopts a database created under that exact name.
  const database = new k8s.apiextensions.CustomResource(
    `${clusterName}-${dbName}-database`,
    {
      apiVersion: MARIADB_API_VERSION,
      kind: DATABASE_KIND,
      metadata: {
        name: `${clusterName}-${dbName}`,
        namespace: DATA_NAMESPACE,
        labels,
      },
      spec: {
        mariaDbRef: { name: clusterName },
        name: dbName,
        characterSet: DEFAULT_CHARACTER_SET,
        collate: DEFAULT_COLLATION,
      },
    },
    { provider, dependsOn: [mariadb], ignoreChanges: DATABASE_IMMUTABLE_FIELDS }
  );

  // The owner's User and Grant CRs deliberately omit `spec.host`: the live
  // objects were created without it and rely on the operator's own default, so
  // writing it explicitly would diff an immutable field on every existing stack.
  const owner = provisionMariadbRole({
    clusterName,
    dbName,
    roleName: username,
    naming: ownerNaming,
    grants: [OWNER_GRANT],
    labels,
    mariadb,
    database,
    provider,
  });

  const secrets = replicateMariadbConnectionSecrets({
    naming: ownerNaming,
    namespaces: ownerConfig.namespaces,
    dbName,
    username,
    password: owner.credentials.stablePassword,
    endpoint,
    port,
    labels,
    provider,
    dependsOn: owner.grants,
  });

  return {
    name: dbName,
    clusterName,
    host: endpoint,
    port,
    database: pulumi.output(dbName),
    secrets,
    nativeResource: database,

    addRole(roleName: string, roleConfig?: IDatabaseRoleConfig): IDatabaseRole {
      assertValidRoleName(roleName, dbName);

      // The owner already has a User CR from createDatabase(). Adding it again
      // would create a SECOND CR for the same MariaDB account, bound to a
      // different password Secret, and the two would then reconcile that
      // account's password against each other indefinitely — leaving the
      // owner's replicated connection Secrets holding a credential that no
      // longer authenticates. The two CRs have different Pulumi logical names,
      // so `pulumi preview` sees no conflict and this fails only in production.
      if (roleName === username) {
        throw new AnyCloudError(
          `Role "${roleName}" is the owner of database "${dbName}" and is created by ` +
            `createDatabase(); it cannot be added again. Use a different role name — on ` +
            `MariaDB the owner is always the database name.`,
          ERROR_CODES.UNSUPPORTED_ROLE_OPTION
        );
      }

      const resolved = resolveRoleConfig(roleConfig);

      // Every MariaDB account is a login account — `CREATE USER` has no
      // non-login form. Honouring `login: false` by ignoring it would hand back
      // a role that can log in when the caller asked for one that cannot.
      if (!resolved.login) {
        throw new AnyCloudError(
          `Role "${roleName}" cannot be created with login: false on MariaDB — every ` +
            `MariaDB user is a login account. Omit "login", or grant no privileges instead.`,
          ERROR_CODES.UNSUPPORTED_ROLE_OPTION
        );
      }

      // A `postgresql` block here names an engine that will never run this
      // role, so its memberships, connection cap and expiry would be dropped
      // while the role provisioned as if they had been applied.
      assertNoForeignEngineOptions({
        roleName,
        databaseName: dbName,
        engineOptions: roleConfig?.engineOptions,
        honoured: "mariadb",
        engine: MARIADB_ENGINE_NAME,
      });

      const mariadbOptions = roleConfig?.engineOptions?.mariadb;
      const host = mariadbOptions?.host ?? DEFAULT_GRANT_HOST;

      // Translated before the claim below, not where the CRs are built, because
      // this throws: a privilege MariaDB cannot carry in a database-scoped
      // GRANT is rejected here. Claiming first and translating afterwards left
      // the account claimed for a role that was never provisioned, so a caller
      // who fixed the privilege and retried in the same program run was refused
      // as a duplicate.
      //
      // `grants: []` and an omitted `grants` both come to the same thing on
      // MariaDB: no `Grant` CRs. Removing a grant from config deletes its CR and
      // mariadb-operator issues the `REVOKE`, so the revoke semantics
      // `grants: []` asks for are what the declarative path already gives.
      const grants = toMariadbGrants(resolved.grants ?? []);

      // Same hazard one scope wider: the check above only sees this database's
      // own owner, while this `user`@`host` pair may already belong to a sibling
      // database on the same instance — the same account, since MariaDB has only
      // one. The registry is what notices. A different host is a different
      // account, and stays allowed.
      //
      // Claimed after every rejecting guard, not before them, so a call they
      // reject leaves no claim behind.
      claimMariadbRoleName(roleRegistry, roleName, host, dbName);

      const naming = additionalRoleNaming(clusterName, dbName, roleName);

      const provisioned = provisionMariadbRole({
        clusterName,
        dbName,
        roleName,
        naming,
        grants,
        host,
        maxUserConnections: mariadbOptions?.maxUserConnections,
        labels,
        mariadb,
        database,
        provider,
      });

      // The connection Secret waits on every Grant CR so a consumer cannot read
      // working credentials, connect, and hit permission errors before the
      // privileges have landed. A role with no grants waits on the User CR.
      const roleSecrets = replicateMariadbConnectionSecrets({
        naming,
        namespaces: resolved.namespaces,
        dbName,
        username: roleName,
        password: provisioned.credentials.stablePassword,
        endpoint,
        port,
        labels,
        provider,
        dependsOn:
          provisioned.grants.length > 0 ? provisioned.grants : [database, provisioned.user],
      });

      return {
        name: roleName,
        databaseName: dbName,
        clusterName,
        secrets: roleSecrets,
        nativeResource: provisioned.user,
      };
    },
  };
}
