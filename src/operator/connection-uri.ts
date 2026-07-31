/**
 * Percent-encoding for the connection URIs replicated into consuming namespaces.
 *
 * Every backend publishes a `uri` key alongside the separate `username`,
 * `password` and `database` keys, and a URI is a *structured* string: `:`
 * separates the user from the password, `@` separates the userinfo from the
 * host, `/` starts the path, and `?` starts the query. Role names are
 * caller-controlled and the role-name validator rejects only characters that
 * would break out of a database identifier — backtick, quotes, backslash, NUL —
 * so a perfectly legal name like `reporting@corp` or `reader:ro` reaches this
 * layer intact.
 *
 * Interpolated raw, `reporting@corp` turns
 * `postgresql://reporting@corp:pw@host:5432/db` into a URI that every conforming
 * parser reads as user `reporting`, password `corp:pw@host:5432` — wrong
 * credentials against a host that does not exist, from a Secret whose own
 * `username` and `password` keys are perfectly correct. Encoding the components
 * is what keeps the two agreeing.
 *
 * @module operator/connection-uri
 */

/**
 * Percent-encode one component of a connection URI.
 *
 * Applied to the username, the password, and the database path segment — never
 * to the host, port, or the URI's own delimiters. The plain `username` /
 * `password` / `database` Secret keys stay raw: they are consumed as literal
 * values, not parsed as a URI, so encoding them would corrupt them.
 *
 * Generated passwords are base64url today and so already URI-safe, but they are
 * encoded anyway rather than resting on that: a future change to the password
 * alphabet must not silently produce mis-parsing URIs.
 *
 * @param value - Raw component value, e.g. a role name or a password
 * @returns The value with every URI-significant character percent-encoded
 *
 * @example
 * ```typescript
 * `postgresql://${encodeUriComponentValue("reader:ro")}@host:5432/db`;
 * // → "postgresql://reader%3Aro@host:5432/db"
 * ```
 */
export function encodeUriComponentValue(value: string): string {
  return encodeURIComponent(value);
}
