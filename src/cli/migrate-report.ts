/**
 * Shared report types for `nimbus migrate` — the PASS/WARN/FAIL vocabulary
 * every check section reports in, and the printer that renders one.
 *
 * @module cli/migrate-report
 */

/** Section verdicts printed by `nimbus migrate`. */
export const CHECK_STATUS = {
  PASS: "PASS",
  WARN: "WARN",
  FAIL: "FAIL",
} as const;

/** A section verdict: "PASS", "WARN", or "FAIL". */
export type CheckStatus = (typeof CHECK_STATUS)[keyof typeof CHECK_STATUS];

/** Result of one pre-flight check section. */
export interface ISectionResult {
  readonly status: CheckStatus;
  readonly lines: readonly string[];
}

/**
 * Print one report section in `[STATUS] title` form, indenting its detail lines.
 *
 * @param title - Section heading
 * @param section - Section result to print
 */
export function printSection(title: string, section: ISectionResult): void {
  console.log(`\n[${section.status}] ${title}`);
  for (const line of section.lines) {
    console.log(`  ${line}`);
  }
}
