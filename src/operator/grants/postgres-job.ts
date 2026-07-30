/**
 * Applies compiled grant SQL to a CloudNativePG database.
 *
 * CNPG's `Database` and `DatabaseRole` CRDs create databases, roles, and
 * ownership, but cannot express privilege grants — there is no CRD field for
 * "GRANT SELECT ON ALL TABLES IN SCHEMA marts TO reader". This Job closes that
 * gap: it runs `psql` against the cluster, authenticated as the database
 * owner (never superuser), executing SQL compiled by
 * {@link compileGrantSql}.
 *
 * The SQL reaches the container exclusively through a mounted ConfigMap, so
 * no user-controlled value is ever interpolated into `command`. The Job's
 * name embeds a checksum of the cluster, database, role, and compiled SQL, so
 * an unchanged grant spec reuses the same Job (Pulumi diffs it as a no-op)
 * and a changed spec — or the same grants applied to a different database —
 * always produces a new, distinct Job.
 *
 * @module operator/grants/postgres-job
 */

import * as crypto from "node:crypto";
import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import { compileGrantSql } from "./postgres-sql.js";
import type { IDatabaseGrant } from "../interfaces.js";

/** Image repository for the `psql` client used to apply grants. */
const PG_IMAGE_REPO = "ghcr.io/cloudnative-pg/postgresql";
/** How long a finished Job (and its Pods) stick around before garbage collection. */
const JOB_TTL_SECONDS = 300;
/** Retries before the Job is considered failed. */
const JOB_BACKOFF_LIMIT = 5;
/** Prefix identifying grant-reconciliation Jobs, distinct from CNPG's own Jobs. */
const JOB_NAME_PREFIX = "cnpg-grants";
/** Suffix appended to the Job name to derive the SQL ConfigMap's name. */
const CONFIG_MAP_NAME_SUFFIX = "-sql";
/** Key under which the compiled SQL is stored in the ConfigMap. */
const SQL_CONFIG_MAP_KEY = "grants.sql";
/** Directory the SQL ConfigMap is mounted at inside the container. */
const SQL_MOUNT_PATH = "/sql";
/** Full in-container path to the mounted SQL file, passed to `psql -f`. */
const SQL_FILE_PATH = `${SQL_MOUNT_PATH}/${SQL_CONFIG_MAP_KEY}`;
/** Name of the ConfigMap volume and its mount inside the Pod template. */
const SQL_VOLUME_NAME = "sql";
/** Name of the `psql` container in the Pod template. */
const PSQL_CONTAINER_NAME = "psql";
/** Hex length of the checksum embedded in the Job name. */
const CHECKSUM_LENGTH = 8;
/**
 * Maximum length of a DNS-1123 label (RFC 1123), the constraint Kubernetes
 * enforces on `metadata.name` for Jobs — a Job stamps its name onto the
 * `job-name` label of every Pod it creates, and label values are capped at 63
 * characters.
 */
const DNS_1123_LABEL_MAX_LENGTH = 63;
/**
 * Budget reserved for the checksum suffix (a `-` separator plus
 * {@link CHECKSUM_LENGTH} hex characters) when truncating the descriptive part
 * of the Job name.
 */
const CHECKSUM_SUFFIX_LENGTH = 1 + CHECKSUM_LENGTH;
/**
 * Effective max length for the Job name itself. Reserved below
 * {@link DNS_1123_LABEL_MAX_LENGTH} by the length of {@link CONFIG_MAP_NAME_SUFFIX}
 * so that `${jobName}${CONFIG_MAP_NAME_SUFFIX}` — the ConfigMap's name — is
 * also a valid DNS-1123 label.
 */
const JOB_NAME_MAX_LENGTH = DNS_1123_LABEL_MAX_LENGTH - CONFIG_MAP_NAME_SUFFIX.length;

/** Options for {@link createPostgresGrantJob}. */
export interface IGrantJobOptions {
  /** CNPG cluster the database belongs to. */
  readonly clusterName: string;
  /** Database the grants apply to. */
  readonly databaseName: string;
  /** Role receiving the grants. */
  readonly roleName: string;
  /** Database owner; the Job authenticates as this role, never as superuser. */
  readonly ownerName: string;
  /** Secret holding the owner's existing credentials (must expose a `password` key). */
  readonly ownerSecretName: string;
  /** Desired grants. An empty list (with no `extraSql`) means nothing to apply. */
  readonly grants: ReadonlyArray<IDatabaseGrant>;
  /** Raw SQL appended after the grants; see {@link compileGrantSql}'s `extraSql`. */
  readonly extraSql?: ReadonlyArray<string>;
  /** Namespace to create the Job and ConfigMap in. */
  readonly namespace: string;
  /** Cluster read-write endpoint the Job connects to. */
  readonly endpoint: pulumi.Output<string>;
  /** PostgreSQL major version, used to select the `psql` client image tag. */
  readonly pgVersion: string;
  /** Labels applied to the Job, its Pod template, and the SQL ConfigMap. */
  readonly labels: Record<string, string>;
  /** Kubernetes provider. */
  readonly provider: k8s.Provider;
  /** Resources the Job and ConfigMap must be created after. */
  readonly dependsOn: pulumi.Resource[];
}

/**
 * Sanitize a string into the character set a DNS-1123 label allows
 * (lowercase alphanumeric and `-`), collapsing runs of `-` and trimming any
 * leading or trailing `-` left behind.
 *
 * @param value - Raw string
 * @returns A string safe to use inside a DNS-1123 label
 */
function sanitizeForLabel(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Derive the Job name: a sanitized, checksum-suffixed DNS-1123 label.
 *
 * The checksum is computed over `clusterName`, `databaseName`, `roleName`,
 * and the compiled SQL — newline-joined in that fixed order — not over the
 * SQL alone. `compileGrantSql`'s output encodes only role, owner, schema, and
 * grants; it never encodes the database name. Hashing the SQL by itself would
 * therefore let two different databases in the same cluster that happen to
 * share a role name and identical grants (e.g. a `readonly` role repeated
 * per-database) produce byte-identical SQL, and thus an identical checksum —
 * and if the descriptive prefix is also truncated down to something
 * indistinguishable between them (see below), the two would collide on the
 * same Job name. Including the resource identity in the hash makes that
 * collision impossible while preserving the property the checksum exists
 * for: `clusterName`, `databaseName`, and `roleName` are stable for a given
 * resource, so an unchanged grant spec (unchanged SQL) still yields an
 * unchanged Job name and does not re-run, while a changed spec — anywhere in
 * cluster, database, role, or SQL — always produces a different name and
 * therefore a Job that actually runs.
 *
 * Cluster, database, and role names are user-controlled and unbounded in
 * length; when the descriptive prefix would push the full name past
 * {@link JOB_NAME_MAX_LENGTH}, it is truncated and the checksum suffix —
 * which is what actually guarantees change-detection and collision-avoidance
 * — is always kept intact.
 *
 * @param clusterName - CNPG cluster name
 * @param databaseName - Database name
 * @param roleName - Role name
 * @param sql - Compiled SQL the Job will apply
 * @returns A DNS-1123-label-safe Job name, at most {@link JOB_NAME_MAX_LENGTH} characters
 */
function deriveJobName(
  clusterName: string,
  databaseName: string,
  roleName: string,
  sql: string
): string {
  const identity = [clusterName, databaseName, roleName, sql].join("\n");
  const checksum = crypto
    .createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, CHECKSUM_LENGTH);

  const descriptive = sanitizeForLabel(
    `${JOB_NAME_PREFIX}-${clusterName}-${databaseName}-${roleName}`
  );
  const descriptiveMaxLength = JOB_NAME_MAX_LENGTH - CHECKSUM_SUFFIX_LENGTH;
  const truncated = sanitizeForLabel(descriptive.slice(0, descriptiveMaxLength));

  return `${truncated}-${checksum}`;
}

/**
 * Create a Job that applies grants and extra SQL to a CNPG-managed database,
 * or nothing at all when there is no SQL to run.
 *
 * The Job authenticates as `options.ownerName` using the password from
 * `options.ownerSecretName`, and executes the compiled SQL with
 * `psql -v ON_ERROR_STOP=1 -f <mounted file>` so a failing statement fails
 * the Job instead of being silently skipped. The SQL itself is mounted from a
 * ConfigMap — it never appears in `command`, so nothing derived from role,
 * schema, or grant data is ever passed as a shell argument.
 *
 * The Job's name is derived from its content (cluster, database, role, and
 * compiled SQL — see {@link deriveJobName}), so a Job that exhausts
 * `backoffLimit` and permanently fails is **not** retried by a later
 * `pulumi up` as long as the grant spec is unchanged: the same input still
 * derives the same name, and Pulumi sees no diff against the existing
 * (failed) Job. Recovering from a permanent failure requires deleting the
 * failed Job manually (e.g. `kubectl delete job <name>`) before re-running
 * Pulumi, so a new Job is created and actually runs.
 *
 * @param options - Cluster, role, owner, grants, and dependencies
 * @returns The Job, or `undefined` when `grants` and `extraSql` are both empty
 * @throws {AnyCloudError} code `UNSUPPORTED_PRIVILEGE` when a grant lists a
 *   privilege {@link compileGrantSql} does not support
 */
export function createPostgresGrantJob(options: IGrantJobOptions): k8s.batch.v1.Job | undefined {
  const { grants, extraSql = [] } = options;
  if (grants.length === 0 && extraSql.length === 0) {
    return undefined;
  }

  const sql = compileGrantSql({
    role: options.roleName,
    owner: options.ownerName,
    grants,
    extraSql,
  });

  const jobName = deriveJobName(options.clusterName, options.databaseName, options.roleName, sql);
  const configMapName = `${jobName}${CONFIG_MAP_NAME_SUFFIX}`;

  const sqlConfigMap = new k8s.core.v1.ConfigMap(
    configMapName,
    {
      metadata: {
        name: configMapName,
        namespace: options.namespace,
        labels: options.labels,
      },
      data: { [SQL_CONFIG_MAP_KEY]: sql },
    },
    { provider: options.provider, dependsOn: options.dependsOn }
  );

  return new k8s.batch.v1.Job(
    jobName,
    {
      metadata: {
        name: jobName,
        namespace: options.namespace,
        labels: options.labels,
      },
      spec: {
        ttlSecondsAfterFinished: JOB_TTL_SECONDS,
        backoffLimit: JOB_BACKOFF_LIMIT,
        template: {
          metadata: { labels: options.labels },
          spec: {
            restartPolicy: "Never",
            containers: [
              {
                name: PSQL_CONTAINER_NAME,
                image: `${PG_IMAGE_REPO}:${options.pgVersion}`,
                command: ["psql", "-v", "ON_ERROR_STOP=1", "-f", SQL_FILE_PATH],
                env: [
                  { name: "PGHOST", value: options.endpoint },
                  { name: "PGDATABASE", value: options.databaseName },
                  { name: "PGUSER", value: options.ownerName },
                  {
                    name: "PGPASSWORD",
                    valueFrom: {
                      secretKeyRef: { name: options.ownerSecretName, key: "password" },
                    },
                  },
                  { name: "PGSSLMODE", value: "require" },
                ],
                volumeMounts: [{ name: SQL_VOLUME_NAME, mountPath: SQL_MOUNT_PATH }],
              },
            ],
            volumes: [{ name: SQL_VOLUME_NAME, configMap: { name: configMapName } }],
          },
        },
      },
    },
    { provider: options.provider, dependsOn: [...options.dependsOn, sqlConfigMap] }
  );
}
