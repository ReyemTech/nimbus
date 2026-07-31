/**
 * Deriving Pulumi logical names and Kubernetes object names from raw database
 * identifiers.
 *
 * A role name, or a table name, is a caller-controlled string in the engine's
 * own identifier space, which is far wider than the DNS-1123 space Kubernetes
 * object names live in. Narrowing one into the other is lossy — `Read_Only` and
 * `read_only` are two distinct, simultaneously valid PostgreSQL roles that both
 * narrow to `read-only` — and a lossy name is not merely untidy here: Pulumi
 * identifies a resource by its logical name, so two resources deriving the same
 * one abort the whole preview with a duplicate-URN error. Nothing is
 * provisioned, including the resources that had nothing to do with the clash.
 *
 * {@link toIdentitySegment} closes that by appending a short hash of the raw
 * value to **every** segment it derives, not only to the ones sanitizing
 * changed. Hashing only the lossy ones leaves two namespaces sharing one output
 * space: `Read_Only` encodes to `read-only-7b1060cf`, and the perfectly valid
 * role name `read-only-7b1060cf` — which needs no sanitizing — would pass
 * through unchanged onto that same string. The two roles' Secrets then collide
 * on one Pulumi logical name and abort the preview, which is the exact failure
 * the hash exists to prevent. Hashing unconditionally makes the mapping
 * injective by construction: the hash covers the raw value, so distinct raw
 * inputs cannot meet. The cost is an opaque suffix on every name, which is a
 * fair price for a rule with no exceptions to reason about.
 *
 * **These helpers are for `addRole()`-path names only.** The names
 * `createDatabase()` emits for a database owner are already live in released
 * stacks and are pinned byte-for-byte by each backend's `ownerRoleNaming`;
 * re-deriving one through here would rename it, and Pulumi reads a rename as
 * delete-and-recreate — which for a credential Secret regenerates the password
 * and breaks every application already reading it.
 *
 * @module operator/resource-identity
 */

import { createHash } from "node:crypto";

/** Digest the short hash is truncated from. */
const HASH_ALGORITHM = "sha256";

/**
 * Hex characters of the digest kept as a disambiguating suffix.
 *
 * Eight hex characters is 32 bits. The suffix does not carry the security
 * burden a full digest would — it separates a handful of role names within one
 * database, not arbitrary attacker-chosen preimages — so the length is chosen
 * for readability at a collision probability that is negligible at this scale.
 */
const SHORT_HASH_LENGTH = 8;

/** Longest value the Kubernetes API accepts for a label. */
const MAX_LABEL_VALUE_LENGTH = 63;

/** Characters a DNS-1123 subdomain may not contain, once lowercased. */
const DISALLOWED_CHARS = /[^a-z0-9-]/g;

/** Runs of separators left behind by {@link DISALLOWED_CHARS} replacement. */
const REPEATED_SEPARATORS = /-+/g;

/** Leading and trailing separators, which a DNS-1123 name may not have. */
const EDGE_SEPARATORS = /^-|-$/g;

/**
 * Normalize a string into a DNS-1123 subdomain usable as `metadata.name`.
 *
 * Lossy by construction: every character outside `[a-z0-9-]` becomes `-`, so
 * distinct inputs can produce one output. Use {@link toIdentitySegment} instead
 * wherever the result identifies a resource.
 *
 * @param value - Raw name
 * @returns A lowercase, `-`-separated name safe for `metadata.name`, possibly empty
 */
export function toDnsSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(DISALLOWED_CHARS, "-")
    .replace(REPEATED_SEPARATORS, "-")
    .replace(EDGE_SEPARATORS, "");
}

/**
 * A short, deterministic hash of a raw identifier.
 *
 * @param value - Raw identifier, hashed exactly as given
 * @returns The first {@link SHORT_HASH_LENGTH} hex characters of its digest
 */
function shortHash(value: string): string {
  return createHash(HASH_ALGORITHM).update(value, "utf8").digest("hex").slice(0, SHORT_HASH_LENGTH);
}

/**
 * Derive a resource-name segment that survives sanitization without collisions.
 *
 * The sanitized value is kept as a readable head and the raw value's hash is
 * always appended. Appending it only where sanitizing was lossy would leave the
 * encoded and the pass-through forms sharing one output space — see this
 * module's note — so the suffix is unconditional and the mapping from raw value
 * to segment is injective by construction.
 *
 * The result is a pure function of `value`: a role called `reader` derives
 * `reader-3d094196` on every call, in every process, forever. That matters more
 * than readability here, because Pulumi reads a changed logical name as
 * delete-and-recreate.
 *
 * @param value - Raw identifier as it exists in the database engine
 * @returns A DNS-1123-safe segment, distinct for every distinct raw value
 *
 * @example
 * ```typescript
 * toIdentitySegment("reader"); // "reader-3d094196"
 * toIdentitySegment("Read_Only"); // "read-only-7b1060cf"
 * toIdentitySegment("read_only"); // "read-only-9c586a9b" — a different role
 * toIdentitySegment("read-only-7b1060cf"); // "read-only-7b1060cf-707a9bc6"
 * toIdentitySegment("@@"); // "3330e5ba" — nothing survives sanitizing
 * ```
 */
export function toIdentitySegment(value: string): string {
  const sanitized = toDnsSegment(value);
  // Sanitizing can erase the value entirely (`"@@"`, or the empty string), and
  // a bare `-`-prefixed hash is not a valid DNS-1123 name — so the hash stands
  // alone rather than being suffixed onto nothing.
  return sanitized === "" ? shortHash(value) : `${sanitized}-${shortHash(value)}`;
}

/**
 * Derive a Kubernetes label *value* from a raw identifier.
 *
 * Label values are far more restricted than the identifiers engines accept: the
 * shared role-name validator deliberately permits `reporting@corp`, and `@` is
 * not a legal label character, so the raw name would be rejected by the
 * Kubernetes API when the object carrying the label is applied — after preview
 * has passed and, for a Job, before it can ever run. Values are additionally
 * capped at {@link MAX_LABEL_VALUE_LENGTH} characters.
 *
 * The raw identifier must still be used everywhere it has to be exact: the SQL
 * or Cypher statement that creates the account, and the Secret payload
 * applications authenticate with. This is for labels only.
 *
 * @param value - Raw identifier as it exists in the database engine
 * @returns A valid label value, truncated with a hash suffix when over-long
 */
export function toLabelValue(value: string): string {
  const segment = toIdentitySegment(value);
  if (segment.length <= MAX_LABEL_VALUE_LENGTH) {
    return segment;
  }
  // Truncation is lossy in exactly the way sanitizing is, so it is disambiguated
  // the same way: keep a readable head, and let the hash of the raw value carry
  // the identity.
  const head = segment
    .slice(0, MAX_LABEL_VALUE_LENGTH - SHORT_HASH_LENGTH - 1)
    .replace(EDGE_SEPARATORS, "");
  return `${head}-${shortHash(value)}`;
}
