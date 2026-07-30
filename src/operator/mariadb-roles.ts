/**
 * MariaDB users inside a MariaDB Operator instance.
 *
 * Every user — the database owner created alongside the database, and every
 * role added later via `addRole()` — is provisioned by the single function
 * {@link provisionMariadbRole}. Unlike CloudNativePG, mariadb-operator models
 * privileges declaratively with a `Grant` CRD, so no SQL Job is involved
 * anywhere: an {@link IDatabaseGrant} maps directly onto a `Grant` custom
 * resource and the operator reconciles it continuously.
 *
 * Only the names differ between the two paths, and those names are the one
 * genuinely dangerous part: Pulumi identifies a resource by its logical name,
 * so renaming one deletes and recreates it, and for a credential Secret that
 * regenerates the password and breaks every application already using it.
 * {@link ownerRoleNaming} therefore pins the owner's names to the exact strings
 * live stacks already carry.
 *
 * @module operator/mariadb-roles
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  ALL_OBJECTS,
  ALL_PRIVILEGES,
  ALL_TABLES,
  DATA_NAMESPACE,
  DEFAULT_MAX_USER_CONNECTIONS,
  GRANT_KIND,
  MARIADB_API_VERSION,
  USER_KIND,
  toResourceName,
} from "./mariadb-common.js";
import {
  createRoleCredentials,
  replicateConnectionSecrets,
  type IRoleCredentials,
} from "./credentials.js";
import { normalizePrivilegeAgainst } from "./grants/privileges.js";
import type { IDatabaseGrant } from "./interfaces.js";

/** Fields of the `User` CR that mariadb-operator rejects updates to. */
const USER_IMMUTABLE_FIELDS = ["spec.name"];
/** Fields of the `Grant` CR that mariadb-operator rejects updates to. */
const GRANT_IMMUTABLE_FIELDS = ["spec.database", "spec.username"];

/** Pulumi logical and Kubernetes names for one `Grant` custom resource. */
export interface IMariadbGrantNaming {
  /** Pulumi logical name of the `Grant` custom resource. */
  readonly resource: string;
  /** Kubernetes name of the `Grant` custom resource. */
  readonly metadataName: string;
}

/**
 * Every name — Pulumi logical and Kubernetes — used by one provisioned user.
 *
 * Collecting them in one place keeps the replace-on-rename risk reviewable
 * instead of scattered through the provisioning code.
 */
export interface IMariadbRoleNaming {
  /** Pulumi logical name of the password Secret. */
  readonly credentialResource: string;
  /** Kubernetes name of the password Secret. */
  readonly credentialSecret: string;
  /** Pulumi logical name of the `User` custom resource. */
  readonly userResource: string;
  /** Kubernetes name of the `User` custom resource. */
  readonly userMetadataName: string;
  /** Pulumi logical name prefix of the replicated connection Secrets. */
  readonly connectionResourcePrefix: string;
  /** Kubernetes name of each replicated connection Secret. */
  readonly connectionSecret: string;
  /**
   * Names for the `Grant` custom resource covering `table`.
   *
   * A user may hold any number of grants, so these cannot be plain fields.
   * Keying on the table rather than the grant's position makes reordering a
   * role's `grants` array a no-op and an edit to its privileges an in-place
   * update; only changing the table forces a replace, which is the one case
   * where a replace is correct. The owner holds exactly one grant and ignores
   * the argument entirely, which is how its pre-existing unsuffixed name
   * survives.
   *
   * @param table - The grant's `spec.table`, `"*"` for the whole database
   * @returns The grant's Pulumi logical and Kubernetes names
   */
  grantNaming(table: string): IMariadbGrantNaming;
}

/**
 * Names for the database owner's user.
 *
 * These strings predate the shared provisioner and are reproduced verbatim:
 * `-password-secret`, `-user`, `-grant`, and `-secret-{namespace}` are the
 * logical names live stacks already carry, and `metadata.name` is the
 * unsanitized `{cluster}-{database}` those objects were created under. Do not
 * "tidy" them.
 *
 * @param clusterName - MariaDB instance name
 * @param dbName - Database name
 * @returns The owner user's pinned naming
 */
export function ownerRoleNaming(clusterName: string, dbName: string): IMariadbRoleNaming {
  const base = `${clusterName}-${dbName}`;
  return {
    credentialResource: `${base}-password-secret`,
    credentialSecret: `${base}-user`,
    userResource: `${base}-user`,
    userMetadataName: base,
    connectionResourcePrefix: `${base}-secret`,
    connectionSecret: `${base}-mariadb`,
    grantNaming: () => ({ resource: `${base}-grant`, metadataName: base }),
  };
}

/**
 * Names for a user added via `addRole()`.
 *
 * Every name is prefixed `{cluster}-{database}-role-{role}` so it can never
 * collide with the owner's pinned names above — the owner's names have no
 * `-role-` segment following `{cluster}-{database}`.
 *
 * Grants are named for the table they cover (`*` renders as `all`), never for
 * their position, so reordering a role's `grants` array changes nothing.
 *
 * @param clusterName - MariaDB instance name
 * @param dbName - Database name
 * @param roleName - Role name as it exists in MariaDB
 * @returns Naming for the additional user's resources
 */
export function additionalRoleNaming(
  clusterName: string,
  dbName: string,
  roleName: string
): IMariadbRoleNaming {
  const base = `${clusterName}-${dbName}-role-${toResourceName(roleName)}`;
  return {
    credentialResource: `${base}-secret`,
    credentialSecret: base,
    userResource: `${base}-user`,
    userMetadataName: toResourceName(base),
    connectionResourcePrefix: `${base}-connection`,
    connectionSecret: `${base}-mariadb`,
    grantNaming: (table: string) => {
      const suffix = toResourceName(table === ALL_TABLES ? ALL_OBJECTS : table);
      return {
        resource: `${base}-grant-${suffix}`,
        metadataName: toResourceName(`${base}-grant-${suffix}`),
      };
    },
  };
}

/** One privilege grant expressed in mariadb-operator's own terms. */
export interface IMariadbGrantSpec {
  /** Privileges granted, upper-cased as MariaDB spells them. */
  readonly privileges: ReadonlyArray<string>;
  /** Table the grant is scoped to, or `"*"` for every table in the database. */
  readonly table: string;
  /** Whether the grantee may pass these privileges on to others. */
  readonly grantOption: boolean;
}

/** The database owner's grant: everything on the database, with `GRANT OPTION`. */
export const OWNER_GRANT: IMariadbGrantSpec = {
  privileges: [ALL_PRIVILEGES],
  table: ALL_TABLES,
  grantOption: true,
};

/** Engine name used when reporting a rejected privilege. */
const ENGINE_NAME = "MariaDB";

/**
 * Privileges accepted in {@link IDatabaseGrant.privileges} on MariaDB.
 *
 * These are the privileges MariaDB allows in a database- or table-scoped
 * `GRANT <privileges> ON db.table TO user`, which is exactly the statement
 * mariadb-operator builds from a `Grant` CR. Anything outside the set — a
 * typo, or a global privilege such as `PROCESS` or `SUPER` that cannot be
 * scoped to a database — is rejected here rather than forwarded for the
 * operator's SQL builder to choke on at reconcile time, where the failure
 * surfaces only in operator logs.
 *
 * This is deliberately **not** PostgreSQL's list: `TRUNCATE` does not exist
 * here, while `INDEX`, `DROP`, `EVENT`, `EXECUTE`, and the routine/view
 * privileges do. `GRANT OPTION` is excluded because the CR models it as its
 * own `spec.grantOption` field, not as a privilege.
 */
const ALLOWED_PRIVILEGES: ReadonlySet<string> = new Set([
  ALL_PRIVILEGES,
  "ALTER",
  "ALTER ROUTINE",
  "CREATE",
  "CREATE ROUTINE",
  "CREATE TEMPORARY TABLES",
  "CREATE VIEW",
  "DELETE",
  "DELETE HISTORY",
  "DROP",
  "EVENT",
  "EXECUTE",
  "INDEX",
  "INSERT",
  "LOCK TABLES",
  "REFERENCES",
  "SELECT",
  "SHOW VIEW",
  "TRIGGER",
  "UPDATE",
]);

/**
 * Translate portable grants into mariadb-operator `Grant` specs.
 *
 * `IDatabaseGrant.schema` has no MariaDB equivalent and is dropped — MariaDB
 * has no schema concept distinct from the database itself. `objects` is either
 * a single table name or `"all"`, which becomes `"*"`.
 *
 * @param grants - Portable grants from the role configuration
 * @returns One MariaDB grant spec per input grant, in the same order
 * @throws {AnyCloudError} code `UNSUPPORTED_PRIVILEGE` when a grant names a
 *   privilege outside {@link ALLOWED_PRIVILEGES}
 */
export function toMariadbGrants(
  grants: ReadonlyArray<IDatabaseGrant>
): ReadonlyArray<IMariadbGrantSpec> {
  return grants.map((grant) => ({
    privileges: grant.privileges.map((privilege) =>
      normalizePrivilegeAgainst(privilege, ALLOWED_PRIVILEGES, ENGINE_NAME)
    ),
    table: grant.objects && grant.objects !== ALL_OBJECTS ? grant.objects : ALL_TABLES,
    grantOption: false,
  }));
}

/** Inputs for {@link provisionMariadbRole}. */
export interface IMariadbRoleOptions {
  /** MariaDB instance the user belongs to. */
  readonly clusterName: string;
  /** Database the grants are scoped to. */
  readonly dbName: string;
  /** Username as it will exist in MariaDB, passed through verbatim. */
  readonly roleName: string;
  /** Pinned Pulumi and Kubernetes names for this user's resources. */
  readonly naming: IMariadbRoleNaming;
  /** Grants to create, already translated by {@link toMariadbGrants}. */
  readonly grants: ReadonlyArray<IMariadbGrantSpec>;
  /**
   * Host pattern the user may connect from.
   *
   * Omitted entirely from both CRs when undefined, which is how the owner's
   * pre-existing specs stay byte-identical rather than gaining an explicit
   * copy of the operator's own default.
   */
  readonly host?: string;
  /** Concurrent connection cap. Default: {@link DEFAULT_MAX_USER_CONNECTIONS}. */
  readonly maxUserConnections?: number;
  /** Labels applied to every created object. */
  readonly labels: Record<string, string>;
  /** The `MariaDB` CR the user is created on. */
  readonly mariadb: k8s.apiextensions.CustomResource;
  /** The `Database` CR the grants are scoped to. */
  readonly database: k8s.apiextensions.CustomResource;
  /** Kubernetes provider. */
  readonly provider: k8s.Provider;
}

/** A provisioned user, its grants, and the credentials backing it. */
export interface IMariadbProvisionedRole {
  /** The `User` custom resource. */
  readonly user: k8s.apiextensions.CustomResource;
  /** One `Grant` custom resource per requested grant, in order. */
  readonly grants: ReadonlyArray<k8s.apiextensions.CustomResource>;
  /** The user's password Secret and its stable password. */
  readonly credentials: IRoleCredentials;
}

/**
 * Provision one MariaDB user: a password Secret, the `User` CR that reconciles
 * the account, and one `Grant` CR per requested privilege set.
 *
 * The Secret holds only `password` — the `User` CR names the account itself, so
 * a `username` key would be redundant, and adding one would change the schema
 * of a Secret live applications already read.
 *
 * @param options - Instance, username, pinned naming, and translated grants
 * @returns The `User` CR, its `Grant` CRs, and the credentials it authenticates with
 */
export function provisionMariadbRole(options: IMariadbRoleOptions): IMariadbProvisionedRole {
  const { clusterName, dbName, roleName, naming, host, provider } = options;

  const credentials = createRoleCredentials({
    resourceName: naming.credentialResource,
    secretName: naming.credentialSecret,
    namespace: DATA_NAMESPACE,
    labels: options.labels,
    provider,
    dependsOn: [options.mariadb],
  });

  const user = new k8s.apiextensions.CustomResource(
    naming.userResource,
    {
      apiVersion: MARIADB_API_VERSION,
      kind: USER_KIND,
      metadata: {
        name: naming.userMetadataName,
        namespace: DATA_NAMESPACE,
        labels: options.labels,
      },
      spec: {
        mariaDbRef: { name: clusterName },
        name: roleName,
        passwordSecretKeyRef: {
          name: naming.credentialSecret,
          key: "password",
        },
        ...(host ? { host } : {}),
        maxUserConnections: options.maxUserConnections ?? DEFAULT_MAX_USER_CONNECTIONS,
      },
    },
    {
      provider,
      dependsOn: [options.mariadb, credentials.userSecret],
      ignoreChanges: USER_IMMUTABLE_FIELDS,
    }
  );

  const grants = options.grants.map((grant) => {
    const grantNames = naming.grantNaming(grant.table);
    return new k8s.apiextensions.CustomResource(
      grantNames.resource,
      {
        apiVersion: MARIADB_API_VERSION,
        kind: GRANT_KIND,
        metadata: {
          name: grantNames.metadataName,
          namespace: DATA_NAMESPACE,
          labels: options.labels,
        },
        spec: {
          mariaDbRef: { name: clusterName },
          privileges: [...grant.privileges],
          database: dbName,
          table: grant.table,
          username: roleName,
          ...(host ? { host } : {}),
          grantOption: grant.grantOption,
        },
      },
      {
        provider,
        dependsOn: [options.database, user],
        ignoreChanges: GRANT_IMMUTABLE_FIELDS,
      }
    );
  });

  return { user, grants, credentials };
}

/** Inputs for {@link replicateMariadbConnectionSecrets}. */
export interface IMariadbConnectionSecretOptions {
  /** Pinned naming for the user whose credentials are replicated. */
  readonly naming: IMariadbRoleNaming;
  /** Namespaces to replicate into. */
  readonly namespaces: ReadonlyArray<string>;
  /** Database the connection points at. */
  readonly dbName: string;
  /** User the connection authenticates as. */
  readonly username: string;
  /** The user's password, read back from its Secret. */
  readonly password: pulumi.Output<string>;
  /** Instance endpoint. */
  readonly endpoint: pulumi.Output<string>;
  /** Instance port. */
  readonly port: pulumi.Output<number>;
  /** Labels applied to each Secret. */
  readonly labels: Record<string, string>;
  /** Kubernetes provider. */
  readonly provider: k8s.Provider;
  /** Resources each Secret must be created after. */
  readonly dependsOn: ReadonlyArray<pulumi.Resource>;
}

/**
 * Replicate a user's connection details into each consuming namespace.
 *
 * @param options - Naming, namespaces, connection details, and dependencies
 * @returns Map of namespace → created Secret name
 */
export function replicateMariadbConnectionSecrets(
  options: IMariadbConnectionSecretOptions
): Record<string, pulumi.Output<string>> {
  const { dbName, username, password, endpoint, port } = options;

  return replicateConnectionSecrets({
    namespaces: options.namespaces,
    resourcePrefix: options.naming.connectionResourcePrefix,
    secretName: options.naming.connectionSecret,
    stringData: {
      host: endpoint,
      port: port.apply((p) => String(p)),
      username,
      password,
      database: dbName,
      uri: pulumi
        .all([endpoint, port, password])
        .apply(([h, p, pw]) => `mysql://${username}:${pw}@${h}:${p}/${dbName}`),
    },
    labels: options.labels,
    provider: options.provider,
    dependsOn: options.dependsOn,
  });
}
