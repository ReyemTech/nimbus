/**
 * Databases inside a CloudNativePG cluster.
 *
 * Provisioning is declarative: a `DatabaseRole` CR owns each login role and its
 * password, and a `Database` CR owns the database and its ownership. The
 * operator reconciles both continuously, so drift (a dropped role, a changed
 * owner) is corrected rather than silently persisting. Privilege grants have no
 * CRD equivalent, so they are applied by a `psql` Job authenticated as the
 * database owner — see {@link createPostgresGrantJob}.
 *
 * @module operator/cnpg-database
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  CNPG_API_VERSION,
  DATA_NAMESPACE,
  DATABASE_KIND,
  ENSURE_PRESENT,
  toResourceName,
} from "./cnpg-common.js";
import {
  additionalRoleNaming,
  ownerRoleNaming,
  provisionCnpgRole,
  replicateCnpgConnectionSecrets,
} from "./cnpg-roles.js";
import { createPostgresGrantJob } from "./grants/postgres-job.js";
import { resolveRoleConfig } from "./grants/role-config.js";
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

/** Inputs for {@link createSingleCnpgDatabaseInstance}. */
export interface ICnpgDatabaseOptions {
  /** CNPG cluster the database is created in. */
  readonly clusterName: string;
  /** Database name, passed to PostgreSQL verbatim. */
  readonly dbName: string;
  /** Per-database configuration, with environments already resolved away. */
  readonly config: Omit<IOperatorDatabaseConfig, "environments">;
  /** Cluster read-write endpoint. */
  readonly endpoint: pulumi.Output<string>;
  /** Cluster port. */
  readonly port: pulumi.Output<number>;
  /** PostgreSQL major version, used to pick the `psql` image for grant Jobs. */
  readonly pgVersion: string;
  /** The CNPG Cluster CR. */
  readonly cluster: k8s.apiextensions.CustomResource;
  /** Kubernetes provider. */
  readonly provider: k8s.Provider;
}

/**
 * Create a single database instance within a CNPG cluster.
 *
 * Both CRs adopt pre-existing objects — CNPG detects the database/role and
 * `ALTER`s it to match the manifest instead of failing — so this is safe to
 * apply on top of databases previously created by the psql bootstrap Job.
 *
 * Connection secrets with the owner's credentials are replicated to the target
 * namespaces, and `config.sql` (if any) is applied by a Job running as the
 * owner. Additional roles are added afterwards via the returned `addRole()`.
 *
 * @param options - Cluster, database name, configuration, and provider
 * @returns The database instance, with `addRole()` bound to it
 * @throws {AnyCloudError} code `INVALID_GRANT` when a role's grant lists no privileges
 * @throws {AnyCloudError} code `UNSUPPORTED_PRIVILEGE` when a grant names a
 *   privilege the SQL compiler cannot emit
 */
export function createSingleCnpgDatabaseInstance(options: ICnpgDatabaseOptions): IDatabaseInstance {
  const { clusterName, dbName, config, endpoint, port, pgVersion, cluster, provider } = options;

  const username = config.owner ?? dbName;
  const labels = {
    [MANAGED_BY_LABEL]: MANAGED_BY_VALUE,
    "nimbus/cluster": clusterName,
    "nimbus/database": dbName,
  };

  const ownerNaming = ownerRoleNaming(clusterName, dbName);
  const ownerConfig = resolveRoleConfig({
    namespaces: config.namespaces,
    login: true,
    reclaimPolicy: config.reclaimPolicy,
  });

  const owner = provisionCnpgRole({
    clusterName,
    roleName: username,
    naming: ownerNaming,
    resolved: ownerConfig,
    labels,
    cluster,
    provider,
  });

  // Database CR: owns the database and its ownership. `spec.name` is the raw
  // PostgreSQL identifier so the CR adopts a database created under that exact
  // name; only metadata.name is sanitized for DNS-1123.
  const database = new k8s.apiextensions.CustomResource(
    `${clusterName}-${dbName}-database-cr`,
    {
      apiVersion: CNPG_API_VERSION,
      kind: DATABASE_KIND,
      metadata: {
        name: toResourceName(`${clusterName}-${dbName}-db`),
        namespace: DATA_NAMESPACE,
        labels,
      },
      spec: {
        cluster: { name: clusterName },
        name: dbName,
        owner: username,
        ensure: ENSURE_PRESENT,
        databaseReclaimPolicy: ownerConfig.reclaimPolicy,
      },
    },
    // The owning role must exist before CREATE DATABASE ... OWNER.
    { provider, dependsOn: [cluster, owner.role] }
  );

  const secrets = replicateCnpgConnectionSecrets({
    naming: ownerNaming,
    namespaces: ownerConfig.namespaces,
    dbName,
    username,
    password: owner.credentials.stablePassword,
    endpoint,
    port,
    labels,
    provider,
    dependsOn: [database],
  });

  // Owner-scoped Job for `config.sql`. It carries no grants, and because the
  // role and the owner are the same the compiler emits no revoke preamble, so
  // this only ever runs the supplied statements. Creates nothing at all when
  // `sql` is omitted.
  createPostgresGrantJob({
    clusterName,
    databaseName: dbName,
    roleName: username,
    ownerName: username,
    ownerSecretName: ownerNaming.credentialSecret,
    grants: [],
    extraSql: config.sql ?? [],
    namespace: DATA_NAMESPACE,
    endpoint,
    pgVersion,
    labels,
    provider,
    dependsOn: [database, owner.role, owner.credentials.userSecret],
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
      const resolved = resolveRoleConfig(roleConfig);
      const naming = additionalRoleNaming(clusterName, dbName, roleName);

      const provisioned = provisionCnpgRole({
        clusterName,
        roleName,
        naming,
        resolved,
        postgresOptions: roleConfig?.engineOptions?.postgresql,
        labels,
        cluster,
        provider,
      });

      const roleSecrets = replicateCnpgConnectionSecrets({
        naming,
        namespaces: resolved.namespaces,
        dbName,
        username: roleName,
        password: provisioned.credentials.stablePassword,
        endpoint,
        port,
        labels,
        provider,
        dependsOn: [database, provisioned.role],
      });

      // Grants are applied as the database owner — never as superuser — so the
      // Job depends on the owner's credential Secret as well as both CRs.
      createPostgresGrantJob({
        clusterName,
        databaseName: dbName,
        roleName,
        ownerName: username,
        ownerSecretName: ownerNaming.credentialSecret,
        grants: resolved.grants,
        namespace: DATA_NAMESPACE,
        endpoint,
        pgVersion,
        labels,
        provider,
        dependsOn: [database, provisioned.role, owner.credentials.userSecret],
      });

      return {
        name: roleName,
        databaseName: dbName,
        clusterName,
        secrets: roleSecrets,
        nativeResource: provisioned.role,
      };
    },
  };
}
