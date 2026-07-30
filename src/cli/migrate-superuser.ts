/**
 * `{cluster}-superuser` Secret consumer check for `nimbus migrate`.
 *
 * `superuserAccess` now defaults to `false`. On an existing cluster this makes
 * CNPG set the `postgres` password to NULL and delete the `{cluster}-superuser`
 * Secret — the one change in this release that mutates live cluster state and
 * that no Pulumi alias can shim. Any out-of-band consumer of that Secret needs
 * a human decision, not an automated fix, so this only ever greps for it.
 *
 * @module cli/migrate-superuser
 */

import { runCommand, splitNonEmptyLines } from "./migrate-exec.js";
import { CHECK_STATUS } from "./migrate-report.js";
import type { ISectionResult } from "./migrate-report.js";

/** Secret name suffix that disappears when `superuserAccess` is `false`. */
export const SUPERUSER_SECRET_SUFFIX = "-superuser";

/** Exit code GNU/BSD grep uses when the pattern matches nothing (not an error for us). */
const GREP_NO_MATCH_EXIT_CODE = 1;

/**
 * Grep the working directory for references to the `{cluster}-superuser` Secret.
 *
 * @returns PASS when nothing references the Secret, WARN otherwise (or when
 *   the scan itself could not run)
 */
export function checkSuperuserConsumers(): ISectionResult {
  const result = runCommand("grep", [
    "-rn",
    "--exclude-dir=node_modules",
    "--exclude-dir=dist",
    "-e",
    SUPERUSER_SECRET_SUFFIX,
    ".",
  ]);

  if (result.ok) {
    const matches = splitNonEmptyLines(result.stdout);
    return {
      status: CHECK_STATUS.WARN,
      lines: [
        `Found ${matches.length} reference(s) to "${SUPERUSER_SECRET_SUFFIX}" outside node_modules/ and dist/:`,
        ...matches.map((match) => `  ${match}`),
        "superuserAccess now defaults to false. On an existing cluster this makes CNPG set the",
        "postgres password to NULL and delete the {cluster}-superuser Secret. Review each hit",
        "above for an out-of-band consumer; if one needs it, set superuserAccess: true explicitly",
        "before upgrading.",
      ],
    };
  }

  if (result.reason === "not-found") {
    return {
      status: CHECK_STATUS.WARN,
      lines: [
        `"grep" was not found on PATH; could not scan for "${SUPERUSER_SECRET_SUFFIX}" consumers.`,
        "Search your working directory manually before upgrading.",
      ],
    };
  }

  if (result.exitCode === GREP_NO_MATCH_EXIT_CODE) {
    return {
      status: CHECK_STATUS.PASS,
      lines: [
        `No references to "${SUPERUSER_SECRET_SUFFIX}" found outside node_modules/ and dist/.`,
      ],
    };
  }

  return {
    status: CHECK_STATUS.WARN,
    lines: [`Could not complete the scan: ${result.message}`],
  };
}
