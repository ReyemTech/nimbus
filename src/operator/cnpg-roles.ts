/**
 * PostgreSQL roles inside a CloudNativePG cluster.
 *
 * Every role — the database owner created alongside the database, and every
 * role added later via `addRole()` — is provisioned by the single function
 * {@link provisionCnpgRole}. Only their names differ, and those names are the
 * one genuinely dangerous part: Pulumi identifies a resource by its logical
 * name, so renaming one deletes and recreates it, and for a credential Secret
 * that regenerates the password and breaks every application already using it.
 * {@link ownerRoleNaming} therefore pins the owner's names to the exact strings
 * live stacks already carry.
 *
 * @module operator/cnpg-roles
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  CNPG_API_VERSION,
  DATA_NAMESPACE,
  DATABASE_ROLE_KIND,
  ENSURE_PRESENT,
  toResourceName,
} from "./cnpg-common.js";
import {
  createRoleCredentials,
  replicateConnectionSecrets,
  type IRoleCredentials,
} from "./credentials.js";
import { encodeUriComponentValue } from "./connection-uri.js";
import {
  DNS_1123_SUBDOMAIN_MAX_LENGTH,
  toBoundedName,
  toIdentitySegment,
} from "./resource-identity.js";
import type { IResolvedRoleConfig } from "./grants/role-config.js";

/** CNPG reads role passwords from Secrets of this type (username + password keys). */
const BASIC_AUTH_SECRET_TYPE = "kubernetes.io/basic-auth";
/** SSL mode embedded in the replicated connection URI. */
const CONNECTION_SSL_MODE = "require";

/**
 * Every name — Pulumi logical and Kubernetes — used by one provisioned role.
 *
 * Collecting them in one place keeps the replace-on-rename risk reviewable
 * instead of scattered through the provisioning code.
 */
export interface ICnpgRoleNaming {
  /** Pulumi logical name of the Opaque credential Secret. */
  readonly credentialResource: string;
  /** Kubernetes name of the Opaque credential Secret. */
  readonly credentialSecret: string;
  /** Pulumi logical name of the basic-auth projection Secret. */
  readonly basicAuthResource: string;
  /** Kubernetes name of the basic-auth projection Secret. */
  readonly basicAuthSecret: string;
  /** Pulumi logical name of the `DatabaseRole` custom resource. */
  readonly roleResource: string;
  /** Kubernetes name of the `DatabaseRole` custom resource. */
  readonly roleMetadataName: string;
  /** Pulumi logical name prefix of the replicated connection Secrets. */
  readonly connectionResourcePrefix: string;
  /** Kubernetes name of each replicated connection Secret. */
  readonly connectionSecret: string;
}

/**
 * Names for the database owner's role.
 *
 * These strings predate the shared provisioner and are reproduced verbatim:
 * `-user-secret`, `-role-secret`, `-role-cr`, and `-secret-{namespace}` are the
 * logical names live stacks already carry. Do not "tidy" them.
 *
 * @param clusterName - CNPG cluster name
 * @param dbName - Database name
 * @returns The owner role's pinned naming
 */
export function ownerRoleNaming(clusterName: string, dbName: string): ICnpgRoleNaming {
  const base = `${clusterName}-${dbName}`;
  return {
    credentialResource: `${base}-user-secret`,
    credentialSecret: `${base}-user`,
    basicAuthResource: `${base}-role-secret`,
    basicAuthSecret: `${base}-role`,
    roleResource: `${base}-role-cr`,
    roleMetadataName: toResourceName(`${base}-role`),
    connectionResourcePrefix: `${base}-secret`,
    connectionSecret: `${base}-pg`,
  };
}

/**
 * Names for a role added via `addRole()`.
 *
 * Every name is prefixed `{cluster}-{database}-role-{role}` so it can never
 * collide with the owner's pinned names above — the owner's shortest stem is
 * `{cluster}-{database}-role`, which this only matches for an empty role name.
 *
 * The role segment comes from {@link toIdentitySegment}, not from plain
 * sanitizing: `Read_Only` and `read_only` are two distinct, simultaneously valid
 * PostgreSQL roles that sanitize alike, and two resources deriving one logical
 * name abort the entire preview with a duplicate-URN error. Every segment
 * carries the hash, including names that needed no sanitizing, so no raw name
 * can land on another's encoded form.
 *
 * Every name is then bounded by {@link toBoundedName}: cluster, database and
 * role names are all caller-controlled and unbounded, and a `metadata.name` over
 * {@link DNS_1123_SUBDOMAIN_MAX_LENGTH} is rejected by the Kubernetes API at
 * apply time — after preview has passed, so the Secrets and the `DatabaseRole`
 * the role needs are never created. The grant Job, which is bound by the
 * stricter 63-character label limit, names itself: see `createPostgresGrantJob`.
 *
 * @param clusterName - CNPG cluster name
 * @param dbName - Database name
 * @param roleName - Role name as it exists in PostgreSQL
 * @returns Naming for the additional role's resources, each within the DNS-1123
 *   subdomain limit
 */
export function additionalRoleNaming(
  clusterName: string,
  dbName: string,
  roleName: string
): ICnpgRoleNaming {
  const base = `${clusterName}-${dbName}-role-${toIdentitySegment(roleName)}`;
  const bounded = (name: string): string => toBoundedName(name, DNS_1123_SUBDOMAIN_MAX_LENGTH);
  return {
    credentialResource: bounded(`${base}-secret`),
    credentialSecret: bounded(base),
    basicAuthResource: bounded(`${base}-auth-secret`),
    basicAuthSecret: bounded(`${base}-auth`),
    roleResource: bounded(`${base}-cr`),
    roleMetadataName: bounded(toResourceName(base)),
    connectionResourcePrefix: bounded(`${base}-connection`),
    connectionSecret: bounded(`${base}-pg`),
  };
}

/**
 * PostgreSQL-specific role attributes.
 *
 * Mirrors `IDatabaseRoleConfig.engineOptions.postgresql`; declared separately so
 * this module depends on a named shape rather than an inline anonymous one.
 */
export interface ICnpgPostgresRoleOptions {
  /** Existing roles this role becomes a member of (e.g. `["pg_read_all_data"]`). */
  readonly inRoles?: string[];
  /** Maximum concurrent connections. Default: unlimited. */
  readonly connectionLimit?: number;
  /** Timestamp after which the password expires. */
  readonly validUntil?: string;
}

/** Inputs for {@link provisionCnpgRole}. */
export interface ICnpgRoleOptions {
  /** CNPG cluster the role belongs to. */
  readonly clusterName: string;
  /** Role name as it will exist in PostgreSQL, passed through verbatim. */
  readonly roleName: string;
  /** Pinned Pulumi and Kubernetes names for this role's resources. */
  readonly naming: ICnpgRoleNaming;
  /** Role configuration with defaults applied. */
  readonly resolved: IResolvedRoleConfig;
  /** Optional PostgreSQL-only role attributes. */
  readonly postgresOptions?: ICnpgPostgresRoleOptions;
  /** Labels applied to every created object. */
  readonly labels: Record<string, string>;
  /** The CNPG Cluster CR the role is created in. */
  readonly cluster: k8s.apiextensions.CustomResource;
  /** Kubernetes provider. */
  readonly provider: k8s.Provider;
}

/** A provisioned role and the credentials backing it. */
export interface ICnpgProvisionedRole {
  /** The `DatabaseRole` custom resource. */
  readonly role: k8s.apiextensions.CustomResource;
  /** The role's Opaque credential Secret and its stable password. */
  readonly credentials: IRoleCredentials;
}

/**
 * Provision one PostgreSQL role: a credential Secret, its basic-auth
 * projection, and the `DatabaseRole` CR that reconciles the role itself.
 *
 * Two Secrets exist because `Secret.type` is immutable in Kubernetes: the
 * Opaque credential Secret cannot be converted to `kubernetes.io/basic-auth`
 * (the only shape the CNPG `DatabaseRole` controller reads) without a replace,
 * which would regenerate the password.
 *
 * Adopting an existing role forces omitted attributes back to their defaults,
 * so `login` is always set explicitly.
 *
 * @param options - Cluster, role name, pinned naming, and resolved config
 * @returns The `DatabaseRole` CR plus the credentials it authenticates with
 */
export function provisionCnpgRole(options: ICnpgRoleOptions): ICnpgProvisionedRole {
  const { naming, resolved, postgresOptions, provider, roleName } = options;

  const credentials = createRoleCredentials({
    resourceName: naming.credentialResource,
    secretName: naming.credentialSecret,
    namespace: DATA_NAMESPACE,
    username: roleName,
    labels: options.labels,
    provider,
    dependsOn: [options.cluster],
  });

  const basicAuthSecret = new k8s.core.v1.Secret(
    naming.basicAuthResource,
    {
      metadata: {
        name: naming.basicAuthSecret,
        namespace: DATA_NAMESPACE,
        labels: options.labels,
      },
      type: BASIC_AUTH_SECRET_TYPE,
      stringData: {
        username: roleName,
        password: credentials.stablePassword,
      },
    },
    { provider, dependsOn: [credentials.userSecret] }
  );

  const role = new k8s.apiextensions.CustomResource(
    naming.roleResource,
    {
      apiVersion: CNPG_API_VERSION,
      kind: DATABASE_ROLE_KIND,
      metadata: {
        name: naming.roleMetadataName,
        namespace: DATA_NAMESPACE,
        labels: options.labels,
      },
      spec: {
        cluster: { name: options.clusterName },
        name: roleName,
        ensure: ENSURE_PRESENT,
        login: resolved.login,
        passwordSecret: { name: naming.basicAuthSecret },
        databaseRoleReclaimPolicy: resolved.reclaimPolicy,
        ...(postgresOptions?.inRoles ? { inRoles: postgresOptions.inRoles } : {}),
        ...(postgresOptions?.connectionLimit !== undefined
          ? { connectionLimit: postgresOptions.connectionLimit }
          : {}),
        ...(postgresOptions?.validUntil ? { validUntil: postgresOptions.validUntil } : {}),
      },
    },
    { provider, dependsOn: [options.cluster, basicAuthSecret] }
  );

  return { role, credentials };
}

/** Inputs for {@link replicateCnpgConnectionSecrets}. */
export interface ICnpgConnectionSecretOptions {
  /** Pinned naming for the role whose credentials are replicated. */
  readonly naming: ICnpgRoleNaming;
  /** Namespaces to replicate into. */
  readonly namespaces: ReadonlyArray<string>;
  /** Database the connection points at. */
  readonly dbName: string;
  /** Role the connection authenticates as. */
  readonly username: string;
  /** The role's password, read back from its credential Secret. */
  readonly password: pulumi.Output<string>;
  /** Cluster read-write endpoint. */
  readonly endpoint: pulumi.Output<string>;
  /** Cluster port. */
  readonly port: pulumi.Output<number>;
  /** Labels applied to each Secret. */
  readonly labels: Record<string, string>;
  /** Kubernetes provider. */
  readonly provider: k8s.Provider;
  /** Resources each Secret must be created after — always includes the `Database` CR. */
  readonly dependsOn: ReadonlyArray<pulumi.Resource>;
}

/**
 * Replicate a role's connection details into each consuming namespace.
 *
 * The `username`, `password` and `database` keys carry raw values; only the
 * composed `uri` percent-encodes them, because there a `@` or `:` in a role name
 * would otherwise be read as a URI delimiter. See {@link encodeUriComponentValue}.
 *
 * @param options - Naming, namespaces, connection details, and dependencies
 * @returns Map of namespace → created Secret name
 */
export function replicateCnpgConnectionSecrets(
  options: ICnpgConnectionSecretOptions
): Record<string, pulumi.Output<string>> {
  const { dbName, username, password, endpoint, port } = options;
  const uriUsername = encodeUriComponentValue(username);
  const uriDatabase = encodeUriComponentValue(dbName);

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
        .apply(
          ([h, p, pw]) =>
            `postgresql://${uriUsername}:${encodeUriComponentValue(pw)}@${h}:${p}/` +
            `${uriDatabase}?sslmode=${CONNECTION_SSL_MODE}`
        ),
    },
    labels: options.labels,
    provider: options.provider,
    dependsOn: options.dependsOn,
  });
}
