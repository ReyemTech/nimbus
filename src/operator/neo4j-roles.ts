/**
 * Neo4j users inside a Neo4j deployment.
 *
 * Every user — the database owner created alongside the database, and every
 * role added later via `addRole()` — is provisioned by the single function
 * {@link provisionNeo4jRole}. Neo4j is the odd backend out: it has no
 * Kubernetes operator and no CRDs, so there is nothing to reconcile an account
 * declaratively. A user is created by a one-shot `cypher-shell` Job running
 * `CREATE OR REPLACE USER`, which is idempotent in effect — every run leaves the
 * account existing with exactly the password its Secret holds — but is applied
 * once rather than continuously, so drift between runs is not corrected.
 *
 * Nothing here grants privileges. `neo4j:community` has no RBAC at all, so a
 * provisioned user is simply an account that can log in; `addRole()` rejects
 * `grants` rather than accepting them and quietly doing nothing.
 *
 * Only the names differ between the two paths, and those names are the one
 * genuinely dangerous part: Pulumi identifies a resource by its logical name,
 * so renaming one deletes and recreates it, and for a credential Secret that
 * regenerates the password and breaks every application already using it.
 * {@link ownerRoleNaming} therefore pins the owner's names to the exact strings
 * live stacks already carry.
 *
 * @module operator/neo4j-roles
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import {
  CYPHER_SHELL_IMAGE,
  DATA_NAMESPACE,
  NEO4J_ADMIN_USER,
  NEO4J_BOLT_PORT,
  NEO4J_HTTP_PORT,
  toResourceName,
} from "./neo4j-common.js";
import {
  createRoleCredentials,
  replicateConnectionSecrets,
  type IRoleCredentials,
} from "./credentials.js";
import { encodeUriComponentValue } from "./connection-uri.js";
import {
  DNS_1123_LABEL_MAX_LENGTH,
  DNS_1123_SUBDOMAIN_MAX_LENGTH,
  toBoundedName,
  toIdentitySegment,
} from "./resource-identity.js";

/** Seconds a completed provisioning Job is kept before Kubernetes reaps it. */
const JOB_TTL_SECONDS = 300;
/** How many times a failed provisioning Job is retried before giving up. */
const JOB_BACKOFF_LIMIT = 5;
/** Container name inside the provisioning Job's pod. */
const CYPHER_SHELL_CONTAINER = "cypher-shell";
/** Key holding the password inside every credential Secret. */
const PASSWORD_KEY = "password";

/**
 * Every name — Pulumi logical and Kubernetes — used by one provisioned user.
 *
 * Collecting them in one place keeps the replace-on-rename risk reviewable
 * instead of scattered through the provisioning code.
 */
export interface INeo4jRoleNaming {
  /** Pulumi logical name of the credential Secret. */
  readonly credentialResource: string;
  /** Kubernetes name of the credential Secret. */
  readonly credentialSecret: string;
  /** Pulumi logical name of the `cypher-shell` provisioning Job. */
  readonly initJobResource: string;
  /** Kubernetes name of the `cypher-shell` provisioning Job. */
  readonly initJobName: string;
  /** Pulumi logical name prefix of the replicated connection Secrets. */
  readonly connectionResourcePrefix: string;
  /** Kubernetes name of each replicated connection Secret. */
  readonly connectionSecret: string;
}

/**
 * Names for the database owner's user.
 *
 * These strings predate the shared provisioner and are reproduced verbatim:
 * `-neo4j-password`, `-neo4j-user`, `neo4j-init-user-{cluster}-{database}`, and
 * `-neo4j-secret-{namespace}` are the names live stacks already carry, and the
 * Job's `metadata.name` is the unsanitized string those objects were created
 * under. Do not "tidy" them.
 *
 * @param clusterName - Neo4j deployment name
 * @param dbName - Database name
 * @returns The owner user's pinned naming
 */
export function ownerRoleNaming(clusterName: string, dbName: string): INeo4jRoleNaming {
  const base = `${clusterName}-${dbName}`;
  const jobName = `neo4j-init-user-${base}`;
  return {
    credentialResource: `${base}-neo4j-password`,
    credentialSecret: `${base}-neo4j-user`,
    initJobResource: jobName,
    initJobName: jobName,
    connectionResourcePrefix: `${base}-neo4j-secret`,
    connectionSecret: `${base}-neo4j`,
  };
}

/**
 * Names for a user added via `addRole()`.
 *
 * Every name is prefixed `{cluster}-{database}-role-{role}` so it can never
 * collide with the owner's pinned names above — the owner's names have no
 * `-role-` segment following `{cluster}-{database}`.
 *
 * The role segment comes from {@link toIdentitySegment}, not from plain
 * sanitizing: `Read_Only` and `read_only` are two distinct, simultaneously valid
 * Neo4j usernames that sanitize alike, and two resources deriving one logical
 * name abort the entire preview with a duplicate-URN error. Every segment
 * carries the hash, including names that needed no sanitizing, so no raw name
 * can land on another's encoded form.
 *
 * Every name is then bounded by {@link toBoundedName}, each by the limit that
 * applies to the object it names. Deployment, database and username are all
 * caller-controlled and unbounded, and the provisioning Job's name —
 * `neo4j-init-user-{deployment}-{database}-role-{user}-{hash}` — passes 63
 * characters once they total roughly 32. Kubernetes copies a Job's name into the
 * `job-name` label of every Pod it creates and label values are capped at 63, so
 * an untruncated name is rejected at apply time: preview passes, the Job is
 * refused, and the account it would have created never exists. The Secrets are
 * bound only by the far looser subdomain limit, so they keep their readable
 * names.
 *
 * @param clusterName - Neo4j deployment name
 * @param dbName - Database name
 * @param roleName - Username as it exists in Neo4j
 * @returns Naming for the additional user's resources, each within the limit
 *   Kubernetes enforces on its object kind
 */
export function additionalRoleNaming(
  clusterName: string,
  dbName: string,
  roleName: string
): INeo4jRoleNaming {
  const base = `${clusterName}-${dbName}-role-${toIdentitySegment(roleName)}`;
  const jobName = `neo4j-init-user-${base}`;
  const bounded = (name: string): string => toBoundedName(name, DNS_1123_SUBDOMAIN_MAX_LENGTH);
  return {
    credentialResource: bounded(`${base}-neo4j-password`),
    credentialSecret: bounded(`${base}-neo4j-user`),
    // The Job alone takes the stricter label limit: Kubernetes copies its name
    // into the `job-name` label of every Pod it creates.
    initJobResource: toBoundedName(jobName, DNS_1123_LABEL_MAX_LENGTH),
    initJobName: toBoundedName(toResourceName(jobName), DNS_1123_LABEL_MAX_LENGTH),
    connectionResourcePrefix: bounded(`${base}-neo4j-secret`),
    connectionSecret: bounded(`${base}-neo4j`),
  };
}

/** Inputs for {@link provisionNeo4jRole}. */
export interface INeo4jRoleOptions {
  /** Database the user is provisioned for, used for labelling only. */
  readonly dbName: string;
  /** Username as it will exist in Neo4j, passed to `cypher-shell` verbatim. */
  readonly roleName: string;
  /** Pinned Pulumi and Kubernetes names for this user's resources. */
  readonly naming: INeo4jRoleNaming;
  /** Kubernetes name of the Secret holding the built-in `neo4j` password. */
  readonly adminSecretName: string;
  /** Deployment endpoint the Job connects to over Bolt. */
  readonly endpoint: pulumi.Output<string>;
  /** Labels applied to the credential Secret and the Job. */
  readonly labels: Record<string, string>;
  /** Labels applied to the Job's pod template. */
  readonly podLabels: Record<string, string>;
  /** Kubernetes provider. */
  readonly provider: k8s.Provider;
  /** Resources the Secret and Job must be created after. */
  readonly dependsOn: ReadonlyArray<pulumi.Resource>;
}

/** A provisioned user and the credentials backing it. */
export interface INeo4jProvisionedRole {
  /** The `cypher-shell` Job that creates the account. */
  readonly initJob: k8s.batch.v1.Job;
  /** The user's password Secret and its stable password. */
  readonly credentials: IRoleCredentials;
}

/**
 * Provision one Neo4j user: a password Secret and the `cypher-shell` Job that
 * creates the account with it.
 *
 * The Job runs one statement and nothing else. It used to follow the create with
 * `GRANT ROLE reader, editor`, suffixed `|| true` because the statement is
 * Enterprise-only — which meant the command failed on every Community deployment
 * and the failure was discarded. A grant that cannot be honoured must not be
 * issued at all, so the statement is gone rather than silenced.
 *
 * That statement is `CREATE OR REPLACE USER`, which sets the password
 * unconditionally. `CREATE USER ... IF NOT EXISTS` did not: a Neo4j user is
 * deployment-global and outlives the Pulumi resources that provisioned it, so
 * removing an `addRole()` call and later re-adding it destroyed the credential
 * Secret, generated a fresh password — and then found the account still there.
 * The create was a no-op, every replicated connection Secret carried a password
 * that could not authenticate, and the Job reported success.
 *
 * `CREATE USER ... IF NOT EXISTS` followed by `ALTER USER ... SET PASSWORD` is
 * not the fix it looks like: Neo4j rejects an `ALTER` that sets the password a
 * user already has ("Old password and new password cannot be the same"), which
 * is the state immediately after the create and on every re-run of an unchanged
 * deployment. That pairing would fail the Job on the normal path.
 *
 * What `OR REPLACE` costs is the account itself: it drops and recreates the
 * user. On `neo4j:community` there is nothing else to lose — a user is a name, a
 * password and the change-required flag, all three of which this statement
 * sets — because Community has no roles and no fine-grained privileges. On
 * Enterprise it would discard role grants, which is one more reason `addRole()`
 * rejects `grants` outright rather than pretending to honour them.
 *
 * Re-running is safe. `command` is immutable, so this statement replaces the Job
 * on existing deployments and it runs once more; it writes the password the
 * credential Secret already holds ({@link createRoleCredentials} stores it under
 * `ignoreChanges` and reads it back), so the live account is set to exactly what
 * every connection Secret in the cluster already carries. A re-run cannot
 * desynchronise a working credential — it can only repair a broken one.
 *
 * @param options - Username, pinned naming, admin Secret, and dependencies
 * @returns The provisioning Job and the credentials the account authenticates with
 */
export function provisionNeo4jRole(options: INeo4jRoleOptions): INeo4jProvisionedRole {
  const { naming, roleName, endpoint, provider } = options;

  const credentials = createRoleCredentials({
    resourceName: naming.credentialResource,
    secretName: naming.credentialSecret,
    namespace: DATA_NAMESPACE,
    username: roleName,
    labels: options.labels,
    provider,
    dependsOn: options.dependsOn,
  });

  const initJob = new k8s.batch.v1.Job(
    naming.initJobResource,
    {
      metadata: {
        name: naming.initJobName,
        namespace: DATA_NAMESPACE,
        labels: options.labels,
      },
      spec: {
        ttlSecondsAfterFinished: JOB_TTL_SECONDS,
        backoffLimit: JOB_BACKOFF_LIMIT,
        template: {
          metadata: { labels: options.podLabels },
          spec: {
            restartPolicy: "Never",
            containers: [
              {
                name: CYPHER_SHELL_CONTAINER,
                image: CYPHER_SHELL_IMAGE,
                // `$DB_USER` and `$DB_PASSWORD` are expanded by the shell at run
                // time, never interpolated into the manifest: the password stays
                // inside the Secret it is read from. The username is validated to
                // hold no backtick, so it cannot close the Cypher identifier it
                // sits inside, and the password is base64url, so it cannot close
                // the single-quoted Cypher string literal it sits inside.
                command: [
                  "sh",
                  "-c",
                  `cypher-shell -a "bolt://$NEO4J_HOST:${NEO4J_BOLT_PORT}" -u ${NEO4J_ADMIN_USER} -p "$NEO4J_ADMIN_PASSWORD" "CREATE OR REPLACE USER \\\`$DB_USER\\\` SET PLAINTEXT PASSWORD '$DB_PASSWORD' SET PASSWORD CHANGE NOT REQUIRED"`,
                ],
                env: [
                  { name: "NEO4J_HOST", value: endpoint },
                  {
                    name: "NEO4J_ADMIN_PASSWORD",
                    valueFrom: {
                      secretKeyRef: { name: options.adminSecretName, key: PASSWORD_KEY },
                    },
                  },
                  { name: "DB_USER", value: roleName },
                  {
                    name: "DB_PASSWORD",
                    valueFrom: {
                      secretKeyRef: { name: naming.credentialSecret, key: PASSWORD_KEY },
                    },
                  },
                ],
              },
            ],
          },
        },
      },
    },
    { provider, dependsOn: [...options.dependsOn, credentials.userSecret] }
  );

  return { initJob, credentials };
}

/** Inputs for {@link replicateNeo4jConnectionSecrets}. */
export interface INeo4jConnectionSecretOptions {
  /** Pinned naming for the user whose credentials are replicated. */
  readonly naming: INeo4jRoleNaming;
  /** Namespaces to replicate into. */
  readonly namespaces: ReadonlyArray<string>;
  /** Database the connection points at. */
  readonly dbName: string;
  /** User the connection authenticates as. */
  readonly username: string;
  /** The user's password, read back from its Secret. */
  readonly password: pulumi.Output<string>;
  /** Deployment endpoint. */
  readonly endpoint: pulumi.Output<string>;
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
 * The payload carries both nimbus' generic keys (`host`, `port`, `username`, …)
 * and the `NEO4J_*` names the official drivers read from the environment, so a
 * consumer can mount the Secret with `envFrom` and no key remapping.
 *
 * Only the composed `uri` percent-encodes its components — a `@` or `:` in a
 * username would otherwise be read there as a URI delimiter. Every other key,
 * `NEO4J_USERNAME` and `NEO4J_PASSWORD` included, carries the raw value, because
 * a driver consumes those literally rather than parsing them. See
 * {@link encodeUriComponentValue}.
 *
 * @param options - Naming, namespaces, connection details, and dependencies
 * @returns Map of namespace → created Secret name
 */
export function replicateNeo4jConnectionSecrets(
  options: INeo4jConnectionSecretOptions
): Record<string, pulumi.Output<string>> {
  const { dbName, username, password, endpoint } = options;
  const uriUsername = encodeUriComponentValue(username);

  return replicateConnectionSecrets({
    namespaces: options.namespaces,
    resourcePrefix: options.naming.connectionResourcePrefix,
    secretName: options.naming.connectionSecret,
    stringData: {
      host: endpoint,
      port: String(NEO4J_BOLT_PORT),
      httpPort: String(NEO4J_HTTP_PORT),
      username,
      password,
      database: dbName,
      uri: pulumi
        .all([endpoint, password])
        .apply(
          ([h, pw]) =>
            `bolt://${uriUsername}:${encodeUriComponentValue(pw)}@${h}:${NEO4J_BOLT_PORT}`
        ),
      // App-friendly keys (mountable as envFrom without key remapping)
      NEO4J_URI: pulumi.interpolate`neo4j://${endpoint}:${NEO4J_BOLT_PORT}`,
      NEO4J_USERNAME: username,
      NEO4J_PASSWORD: password,
      NEO4J_DATABASE: dbName,
    },
    labels: options.labels,
    provider: options.provider,
    dependsOn: options.dependsOn,
  });
}
