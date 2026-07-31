/**
 * Machine-readable `psql` output for the `nimbus migrate` checks.
 *
 * `psql -tAc` prints columns separated by `|` and escapes nothing, so a value
 * containing that character is indistinguishable from a column boundary. A role
 * called `read|er` — legal in PostgreSQL, which quotes identifiers — produced a
 * line with ten fields where the parser expected nine, and the row was dropped.
 * The check could then report that every role matches the adoption baseline
 * while having skipped precisely the role whose attributes `DatabaseRole`
 * adoption would reset: a false all-clear from the tool whose entire purpose is
 * catching that.
 *
 * {@link toJsonRowsQuery} wraps a row-returning query so PostgreSQL renders the
 * whole result as one JSON document, which escapes delimiters, quotes and
 * newlines for us. The documented query itself is kept verbatim as the wrapped
 * subquery, so this check and the manual procedure in
 * `docs/cnpg-declarative-databases.md` still cannot drift apart.
 *
 * Nothing here drops a row it cannot read. {@link parseJsonRows} returns the
 * rows it understood **and** a warning for everything else, which the caller
 * surfaces as a WARN naming the row rather than silently omitting it.
 *
 * @module cli/migrate-psql
 */

/** Alias the wrapped query's rows are aggregated under. */
const ROWS_ALIAS = "nimbus_row";

/** Longest fragment of unparseable output echoed back in a warning. */
const MAX_REPORTED_LENGTH = 200;

/**
 * Wrap a row-returning query so `psql -tAc` emits a single JSON array.
 *
 * `json_agg` over `row_to_json` renders every column with its own name and
 * escapes anything a value might contain, so no `|`, newline or quote in a role
 * or database name can shift a field boundary. `coalesce` keeps the output a
 * valid document (`[]`) when the query matches nothing, rather than the empty
 * string `json_agg` returns for no rows.
 *
 * The query is embedded verbatim, so the constant a check runs stays byte-equal
 * to the one the migration guide tells an operator to run by hand.
 *
 * @param query - A row-returning `SELECT`, without a trailing semicolon
 * @returns A query returning one row with one JSON-array column
 *
 * @example
 * ```typescript
 * toJsonRowsQuery("SELECT datname FROM pg_database");
 * // SELECT coalesce(json_agg(row_to_json(nimbus_row)), '[]'::json)
 * // FROM (SELECT datname FROM pg_database) AS nimbus_row
 * ```
 */
export function toJsonRowsQuery(query: string): string {
  return (
    `SELECT coalesce(json_agg(row_to_json(${ROWS_ALIAS})), '[]'::json) ` +
    `FROM (${query}) AS ${ROWS_ALIAS}`
  );
}

/** Rows parsed out of one JSON document, plus what could not be parsed. */
export interface IJsonRowsResult {
  /** Every element that was a JSON object, in the order returned. */
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  /** One line per unreadable element, or per wholly unusable output. */
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Render a value into a warning without pasting an entire query result into the
 * report.
 *
 * @param value - Value to describe
 * @returns A short, single-line rendering, truncated with an ellipsis
 */
function describeValue(value: unknown): string {
  const rendered = typeof value === "string" ? value : JSON.stringify(value);
  const oneLine = (rendered ?? String(value)).replace(/\s+/g, " ").trim();
  return oneLine.length > MAX_REPORTED_LENGTH
    ? `${oneLine.slice(0, MAX_REPORTED_LENGTH)}…`
    : oneLine;
}

/**
 * Parse the output of a {@link toJsonRowsQuery} query into row objects.
 *
 * A row that cannot be used is reported, never dropped: the caller turns each
 * warning into a WARN line, so an unreadable row downgrades the check instead of
 * quietly shrinking the set it claims to have inspected.
 *
 * @param stdout - Raw `psql -tAc` output
 * @param subject - What the query was reading, named in warnings (e.g. "pg_roles")
 * @returns The object rows, and a warning for anything unusable
 */
export function parseJsonRows(stdout: string, subject: string): IJsonRowsResult {
  const text = stdout.trim();
  if (text === "") {
    return {
      rows: [],
      warnings: [`the ${subject} query returned no output; nothing was checked.`],
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      rows: [],
      warnings: [
        `could not parse the ${subject} query output as JSON (${reason}): ${describeValue(text)}`,
      ],
    };
  }

  if (!Array.isArray(parsed)) {
    return {
      rows: [],
      warnings: [
        `the ${subject} query returned ${describeValue(parsed)}, which is not a list of rows.`,
      ],
    };
  }

  const rows: Record<string, unknown>[] = [];
  const warnings: string[] = [];
  parsed.forEach((element: unknown, index: number) => {
    if (typeof element === "object" && element !== null && !Array.isArray(element)) {
      rows.push(element as Record<string, unknown>);
      return;
    }
    warnings.push(
      `${subject} row ${index + 1} is not an object and was not checked: ${describeValue(element)}`
    );
  });

  return { rows, warnings };
}

/**
 * Read a column that must hold a non-empty string.
 *
 * @param row - Parsed row
 * @param column - Column name
 * @returns The value, or undefined when absent, empty, or another type
 */
export function readString(row: Record<string, unknown>, column: string): string | undefined {
  const value = row[column];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Read a column that may legitimately hold SQL `NULL`.
 *
 * A nullable column has three states this parser must keep apart: a value, an
 * explicit `NULL` — which is data, not a failure (`rolvaliduntil` NULL is how
 * PostgreSQL spells "this password never expires") — and a column that is absent
 * or of the wrong type, which is unreadable. Only the last may warn, so `null`
 * is returned as itself rather than collapsed into the `undefined` that
 * {@link readString} uses for "could not read this".
 *
 * An empty string is a value here, unlike in {@link readString}: `COMMENT ON
 * ROLE … IS ''` is a real, if pointless, state and must not read as unreadable.
 *
 * @param row - Parsed row
 * @param column - Column name
 * @returns The value, `null` for a SQL `NULL`, or undefined when the column is
 *   absent or of another type
 */
export function readNullableString(
  row: Record<string, unknown>,
  column: string
): string | null | undefined {
  if (!(column in row)) {
    return undefined;
  }
  const value = row[column];
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

/**
 * Read a column that must hold a JSON boolean.
 *
 * PostgreSQL's `boolean` renders as a JSON boolean, not as psql's `t`/`f`, so a
 * `"t"` here means the query was not the wrapped JSON one.
 *
 * @param row - Parsed row
 * @param column - Column name
 * @returns The value, or undefined when absent or another type
 */
export function readBoolean(row: Record<string, unknown>, column: string): boolean | undefined {
  const value = row[column];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * Read a column that must hold a finite JSON number.
 *
 * @param row - Parsed row
 * @param column - Column name
 * @returns The value, or undefined when absent, not finite, or another type
 */
export function readNumber(row: Record<string, unknown>, column: string): number | undefined {
  const value = row[column];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Read a column that must hold an array of strings.
 *
 * A PostgreSQL `text[]` renders as a JSON array, so role memberships arrive
 * already separated — a membership containing a comma or a `|` can no longer
 * blur into its neighbour the way it could in psql's `{a,b}` array text.
 *
 * @param row - Parsed row
 * @param column - Column name
 * @returns The values, or undefined when absent or not an array of strings
 */
export function readStringArray(
  row: Record<string, unknown>,
  column: string
): ReadonlyArray<string> | undefined {
  const value = row[column];
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.every((element: unknown) => typeof element === "string")
    ? (value as string[])
    : undefined;
}
