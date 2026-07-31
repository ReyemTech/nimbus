/**
 * Read-only pre-flight checks for the declarative database roles migration.
 *
 * Nimbus 3.0 replaces the CNPG bootstrap Job with `Database` / `DatabaseRole`
 * custom resources (see `docs/cnpg-declarative-databases.md`). Pulumi resource
 * names are preserved, so the upgrade itself is a no-op for most stacks — but
 * two things can surprise an operator on adoption: a hand-tweaked role losing
 * an attribute the manifest omits, and the `{cluster}-superuser` Secret being
 * deleted when `superuserAccess` falls back to its new default of `false`.
 *
 * This module only ever reads: `kubectl get`, `kubectl exec … psql -tAc`, and
 * a filesystem `grep` (see `migrate-exec.ts`, `migrate-cnpg.ts`,
 * `migrate-superuser.ts`). It never runs `kubectl apply/patch/delete/edit`,
 * `pulumi up`, or writes to any file — it is safe to run against a production
 * cluster before deciding whether to upgrade.
 *
 * @module cli/migrate
 */

import {
  CNPG_DATABASE_CRD_NAME,
  CNPG_DATABASE_ROLE_CRD_NAME,
  checkClusterState,
  checkCnpgCrds,
} from "./migrate-cnpg.js";
import { CHECK_STATUS, printSection } from "./migrate-report.js";
import { SUPERUSER_SECRET_SUFFIX, checkSuperuserConsumers } from "./migrate-superuser.js";

/**
 * Run every read-only pre-flight check for the declarative database roles migration
 * and print a PASS/WARN/FAIL report.
 *
 * This command never mutates anything: no `kubectl apply/patch/delete/edit`, no
 * `pulumi up`, and no writes to the user's files or Pulumi state. It only shells
 * out to `kubectl get`, `kubectl exec … psql -tAc`, and `grep`.
 *
 * @param version - Target nimbus version, echoed in the report header
 * @returns `1` if any check FAILs, `0` otherwise (including when checks WARN)
 *
 * @example
 * ```typescript
 * const exitCode = runMigrateChecks("v3");
 * process.exit(exitCode);
 * ```
 */
export function runMigrateChecks(version: string): number {
  console.log(`Nimbus declarative database roles pre-flight (target: ${version})`);
  console.log("Read-only checks — nothing below mutates your cluster, files, or Pulumi state.");

  const crdOutcome = checkCnpgCrds();
  printSection(
    `1. CloudNativePG CRDs (${CNPG_DATABASE_CRD_NAME}, ${CNPG_DATABASE_ROLE_CRD_NAME})`,
    crdOutcome.section
  );

  const { roleSection, ownershipSection } = checkClusterState(crdOutcome.clusterReachable);
  printSection("2. Role attributes vs. nimbus baseline", roleSection);
  printSection("3. Database ownership", ownershipSection);

  const superuserSection = checkSuperuserConsumers();
  printSection(`4. "${SUPERUSER_SECRET_SUFFIX}" Secret consumers`, superuserSection);

  const sections = [crdOutcome.section, roleSection, ownershipSection, superuserSection];
  const hasFailure = sections.some((section) => section.status === CHECK_STATUS.FAIL);
  const hasWarning = sections.some((section) => section.status === CHECK_STATUS.WARN);

  console.log("");
  if (hasFailure) {
    console.log("Result: FAIL — resolve the FAIL item(s) above before upgrading.");
    return 1;
  }
  if (hasWarning) {
    console.log("Result: PASS WITH WARNINGS — review the WARN item(s) above before upgrading.");
    return 0;
  }
  console.log("Result: PASS — no issues found.");
  return 0;
}
