/**
 * CNPG-specific checks for `nimbus migrate`: CRD presence, role attributes,
 * and database ownership.
 *
 * @module cli/migrate-cnpg
 */

import { DATA_NAMESPACE } from "../operator/cnpg-common.js";
import type { CommandResult, ICommandFailure } from "./migrate-exec.js";
import { runCommand } from "./migrate-exec.js";
import { CHECK_STATUS } from "./migrate-report.js";
import type { ISectionResult } from "./migrate-report.js";
import {
  BUILTIN_ROLE_NAMES,
  ROLE_ATTRIBUTES_JSON_QUERY,
  describeRoleDeviation,
  parseRoleRows,
  roleMatchesBaseline,
} from "./migrate-cnpg-roles.js";
import {
  DATABASE_OWNERSHIP_JSON_QUERY,
  SYSTEM_DATABASE_NAMES,
  parseDatabaseRows,
} from "./migrate-cnpg-ownership.js";

/** CRD name backing the `Database` custom resource. */
export const CNPG_DATABASE_CRD_NAME = "databases.postgresql.cnpg.io";
/** CRD name backing the `DatabaseRole` custom resource. */
export const CNPG_DATABASE_ROLE_CRD_NAME = "databaseroles.postgresql.cnpg.io";

/** Outcome of {@link checkCnpgCrds}. */
export interface ICrdCheckOutcome {
  readonly section: ISectionResult;
  readonly clusterReachable: boolean;
}

/**
 * Check that both CNPG CRDs required by the declarative path exist.
 *
 * @returns The section result plus whether the cluster was reachable, so
 *   downstream checks know whether to attempt a `kubectl exec`
 */
export function checkCnpgCrds(): ICrdCheckOutcome {
  const result = runCommand("kubectl", [
    "get",
    "crd",
    CNPG_DATABASE_CRD_NAME,
    CNPG_DATABASE_ROLE_CRD_NAME,
    "-o",
    "name",
  ]);

  if (result.ok) {
    return {
      section: {
        status: CHECK_STATUS.PASS,
        lines: [`Found ${CNPG_DATABASE_CRD_NAME} and ${CNPG_DATABASE_ROLE_CRD_NAME}.`],
      },
      clusterReachable: true,
    };
  }

  if (result.reason === "not-found") {
    return {
      section: {
        status: CHECK_STATUS.WARN,
        lines: [
          `"kubectl" was not found on PATH. Install kubectl and re-run this check.`,
          "Role attribute and database ownership checks below are skipped as a result.",
        ],
      },
      clusterReachable: false,
    };
  }

  if (/notfound/i.test(result.message)) {
    return {
      section: {
        status: CHECK_STATUS.FAIL,
        lines: [
          `Missing one or both CRDs: ${CNPG_DATABASE_CRD_NAME}, ${CNPG_DATABASE_ROLE_CRD_NAME}.`,
          "The declarative Database/DatabaseRole path requires CloudNativePG 1.30 or newer.",
          "Upgrade the CNPG operator before adopting this release.",
          result.message,
        ],
      },
      clusterReachable: false,
    };
  }

  return {
    section: {
      status: CHECK_STATUS.WARN,
      lines: [
        `Could not reach the cluster to verify CRDs: ${result.message}`,
        "Role attribute and database ownership checks below are skipped as a result.",
      ],
    },
    clusterReachable: false,
  };
}

/**
 * List CNPG cluster names in the namespace nimbus always deploys to.
 *
 * @returns Cluster names on success, or a failure with an explanatory message
 */
function listCnpgClusters(): { readonly ok: true; readonly names: string[] } | ICommandFailure {
  const result = runCommand("kubectl", [
    "get",
    "clusters.postgresql.cnpg.io",
    "-n",
    DATA_NAMESPACE,
    "-o",
    "jsonpath={.items[*].metadata.name}",
  ]);
  if (!result.ok) {
    return result;
  }
  const names = result.stdout
    .trim()
    .split(/\s+/)
    .filter((name) => name.length > 0);
  return { ok: true, names };
}

/**
 * Resolve the primary instance's pod name for a CNPG cluster, so queries run
 * against a writable connection. Falls back to the conventional `<cluster>-1`
 * pod name (used by every nimbus-provisioned cluster's first instance) when
 * the cluster's status has not reported a primary yet.
 *
 * @param clusterName - CNPG `Cluster` object name
 * @returns The pod name to `kubectl exec` into
 */
function resolvePrimaryPod(clusterName: string): string {
  const result = runCommand("kubectl", [
    "get",
    "cluster.postgresql.cnpg.io",
    clusterName,
    "-n",
    DATA_NAMESPACE,
    "-o",
    "jsonpath={.status.currentPrimary}",
  ]);
  const primary = result.ok ? result.stdout.trim() : "";
  return primary.length > 0 ? primary : `${clusterName}-1`;
}

/**
 * Run a read-only `psql -tAc` query inside a cluster's primary pod via `kubectl exec`.
 *
 * @param pod - Pod name to exec into
 * @param query - SQL query text (never built from unsanitised input)
 * @returns The query's unaligned, tuples-only output on success
 */
function runPsqlQuery(pod: string, query: string): CommandResult {
  return runCommand("kubectl", ["exec", "-n", DATA_NAMESPACE, pod, "--", "psql", "-tAc", query]);
}

/** Role attribute and database ownership section results for one migrate run. */
export interface IClusterSections {
  readonly roleSection: ISectionResult;
  readonly ownershipSection: ISectionResult;
}

/**
 * Build a matching WARN result for both cluster-dependent sections, used when
 * they must be skipped for the same reason (kubectl missing, cluster
 * unreachable, or no clusters found).
 *
 * @param reason - Human-readable explanation shown in both sections
 * @returns Identical WARN results for the role and ownership sections
 */
function skippedClusterSections(reason: string): IClusterSections {
  const lines = [reason];
  return {
    roleSection: { status: CHECK_STATUS.WARN, lines },
    ownershipSection: { status: CHECK_STATUS.WARN, lines },
  };
}

/**
 * Check every nimbus-managed CNPG cluster's role attributes and database
 * ownership against the baseline that makes `Database`/`DatabaseRole`
 * adoption a no-op.
 *
 * @param clusterReachable - Whether {@link checkCnpgCrds} could reach the cluster
 * @returns Section results for role attributes and database ownership
 */
export function checkClusterState(clusterReachable: boolean): IClusterSections {
  if (!clusterReachable) {
    return skippedClusterSections(
      "Skipped: could not reach the cluster to verify CRDs (see check 1 above)."
    );
  }

  const discovery = listCnpgClusters();
  if (!discovery.ok) {
    return skippedClusterSections(
      `Skipped: could not list CloudNativePG clusters in namespace "${DATA_NAMESPACE}": ${discovery.message}`
    );
  }

  const clusterNames = discovery.names;
  if (clusterNames.length === 0) {
    return skippedClusterSections(
      `No CloudNativePG clusters found in namespace "${DATA_NAMESPACE}". ` +
        "If you expected clusters here, verify your kubectl context."
    );
  }

  const roleLines: string[] = [];
  const ownershipLines: string[] = [];
  let roleDeviationCount = 0;
  let ownershipMismatchCount = 0;
  let rolesChecked = 0;
  let databasesChecked = 0;
  let roleCheckIncomplete = false;
  let ownershipCheckIncomplete = false;

  for (const clusterName of clusterNames) {
    const pod = resolvePrimaryPod(clusterName);

    const roleResult = runPsqlQuery(pod, ROLE_ATTRIBUTES_JSON_QUERY);
    if (!roleResult.ok) {
      roleCheckIncomplete = true;
      roleLines.push(
        `cluster "${clusterName}": could not query pg_roles on pod "${pod}": ${roleResult.message}`
      );
    } else {
      const parsed = parseRoleRows(roleResult.stdout);
      // A row that could not be parsed is a role this check did NOT inspect, so
      // it downgrades the section rather than shrinking the set it claims to
      // have covered. Reporting "all roles match" while having skipped one is
      // the failure mode this whole command exists to prevent.
      for (const warning of parsed.warnings) {
        roleCheckIncomplete = true;
        roleLines.push(`cluster "${clusterName}": ${warning}`);
      }
      const roles = parsed.roles.filter((role) => !BUILTIN_ROLE_NAMES.includes(role.name));
      rolesChecked += roles.length;
      for (const role of roles) {
        if (!roleMatchesBaseline(role)) {
          roleDeviationCount += 1;
          roleLines.push(`cluster "${clusterName}": ${describeRoleDeviation(role)}`);
        }
      }
    }

    const ownershipResult = runPsqlQuery(pod, DATABASE_OWNERSHIP_JSON_QUERY);
    if (!ownershipResult.ok) {
      ownershipCheckIncomplete = true;
      ownershipLines.push(
        `cluster "${clusterName}": could not query pg_database on pod "${pod}": ${ownershipResult.message}`
      );
    } else {
      const parsed = parseDatabaseRows(ownershipResult.stdout);
      for (const warning of parsed.warnings) {
        ownershipCheckIncomplete = true;
        ownershipLines.push(`cluster "${clusterName}": ${warning}`);
      }
      const databases = parsed.databases.filter(
        (database) => !SYSTEM_DATABASE_NAMES.includes(database.name)
      );
      databasesChecked += databases.length;
      for (const database of databases) {
        if (database.owner !== database.name) {
          ownershipMismatchCount += 1;
          ownershipLines.push(
            `cluster "${clusterName}": database "${database.name}" is owned by role "${database.owner}" ` +
              `— confirm this matches the "owner" set for this database in your Pulumi config.`
          );
        }
      }
    }
  }

  if (roleDeviationCount === 0 && !roleCheckIncomplete) {
    roleLines.unshift(
      `Checked ${rolesChecked} role(s) across ${clusterNames.length} cluster(s); all match the nimbus baseline.`
    );
  } else if (roleDeviationCount > 0) {
    roleLines.unshift(
      `${roleDeviationCount} role(s) deviate from the nimbus baseline. DatabaseRole adoption ` +
        "forces attributes the manifest omits back to this baseline, so any hand-granted " +
        "privilege or membership listed below would be silently revoked."
    );
  }

  if (ownershipMismatchCount === 0 && !ownershipCheckIncomplete) {
    ownershipLines.unshift(
      `Checked ${databasesChecked} database(s) across ${clusterNames.length} cluster(s); ` +
        "ownership matches the nimbus naming convention."
    );
  } else if (ownershipMismatchCount > 0) {
    ownershipLines.unshift(
      `${ownershipMismatchCount} database(s) have an owner that does not match the nimbus default ` +
        "naming convention (owner name equal to database name)."
    );
  }

  return {
    roleSection: {
      status: roleDeviationCount > 0 || roleCheckIncomplete ? CHECK_STATUS.WARN : CHECK_STATUS.PASS,
      lines: roleLines,
    },
    ownershipSection: {
      status:
        ownershipMismatchCount > 0 || ownershipCheckIncomplete
          ? CHECK_STATUS.WARN
          : CHECK_STATUS.PASS,
      lines: ownershipLines,
    },
  };
}
