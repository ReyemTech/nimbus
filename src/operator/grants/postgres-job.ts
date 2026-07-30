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
 * name embeds a checksum of the SQL, so an unchanged grant spec reuses the
 * same Job (Pulumi diffs it as a no-op) and a changed spec produces a new
 * Job that actually runs.
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
/** Hex length of the SQL checksum embedded in the Job name. */
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
 * The checksum is computed over the compiled SQL, so a changed grant spec
 * (different SQL) always produces a different Job name — and therefore a Job
 * that actually runs — while an unchanged spec reuses the same name and
 * Pulumi diffs it as a no-op. Cluster, database, and role names are
 * user-controlled and unbounded in length; when the descriptive prefix would
 * push the full name past {@link JOB_NAME_MAX_LENGTH}, it is truncated and the
 * checksum suffix — which is what actually guarantees change-detection — is
 * always kept intact.
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
  const checksum = crypto.createHash("sha256").update(sql).digest("hex").slice(0, CHECKSUM_LENGTH);

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
                name: "psql",
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
                volumeMounts: [{ name: "sql", mountPath: SQL_MOUNT_PATH }],
              },
            ],
            volumes: [{ name: "sql", configMap: { name: configMapName } }],
          },
        },
      },
    },
    { provider: options.provider, dependsOn: [...options.dependsOn, sqlConfigMap] }
  );
}
