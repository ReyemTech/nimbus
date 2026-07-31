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

/**
 * Longest DNS-1123 *label*: the cap on a label value and on a Job's name.
 *
 * Kubernetes enforces it on every label value, and `batch` validation enforces
 * it on a Job's `metadata.name` — a Job stamps its own name onto the `job-name`
 * label of every Pod it creates, so a longer name could not be labelled.
 */
export const DNS_1123_LABEL_MAX_LENGTH = 63;

/**
 * Longest DNS-1123 *subdomain*: the cap on `metadata.name` for a Secret,
 * ConfigMap, or custom resource.
 *
 * Deliberately not collapsed into {@link DNS_1123_LABEL_MAX_LENGTH}. Bounding
 * every name by the strictest limit would be one rule instead of two, but a
 * perfectly ordinary `Grant` CR name already runs past 63 characters, and
 * truncating it would replace a name an operator can read with an opaque hash
 * for no gain — the API accepts it. Each name is bounded by the limit that
 * actually applies to the object it names.
 */
export const DNS_1123_SUBDOMAIN_MAX_LENGTH = 253;

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
 * Derive a resource-name segment for an identity made of more than one part.
 *
 * Not every engine identifies an account by its name alone: a MariaDB account is
 * the `username`@`host` pair, and `reader`@`%` and `reader`@`10.0.0.1` are two
 * accounts that exist at once with their own passwords and their own grants.
 * Deriving names from the username alone made the second of them register under
 * the first's Pulumi logical names, which aborts the preview with a duplicate
 * URN — so the second account could never be created at all.
 *
 * The head stays readable by sanitizing the **first** part only, which is the
 * one a human recognises the resource by; every part is folded into the hash, so
 * the mapping stays injective the way {@link toIdentitySegment}'s is. The hash
 * covers `JSON.stringify(parts)` rather than the parts joined by a separator,
 * because a part may itself contain any separator: `["a@b", "c"]` and
 * `["a", "b@c"]` are different identities and must not serialize alike.
 *
 * @param parts - The identity's raw parts, most identifying first
 * @returns A DNS-1123-safe segment, distinct for every distinct identity
 *
 * @example
 * ```typescript
 * toCompositeIdentitySegment(["reader", "%"]); // "reader-8b6a1a09"
 * toCompositeIdentitySegment(["reader", "10.0.0.1"]); // "reader-…" — another account
 * ```
 */
export function toCompositeIdentitySegment(parts: readonly [string, ...string[]]): string {
  const sanitized = toDnsSegment(parts[0]);
  const hash = shortHash(JSON.stringify(parts));
  return sanitized === "" ? hash : `${sanitized}-${hash}`;
}

/**
 * Bound an already-derived name to a length limit without losing its identity.
 *
 * Cluster, database, role and table names are all caller-controlled and
 * unbounded, so a name composed from them is unbounded too — and an over-long
 * one is not a cosmetic problem. Kubernetes rejects a Job whose `metadata.name`
 * exceeds {@link DNS_1123_LABEL_MAX_LENGTH} outright, which happens at apply
 * time: preview passes, then the object the account depends on is refused and
 * the account is never created.
 *
 * Truncation is lossy in exactly the way sanitizing is — two names agreeing on
 * their first characters cut down to one string — so it is disambiguated the
 * same way: keep a readable head, and append a hash of the **whole** name. Two
 * distinct inputs therefore stay distinct, and a name that already fits is
 * returned untouched so short names keep their readable form.
 *
 * @param name - Derived name, already sanitized into the target character set
 * @param maxLength - The limit that applies to the object this names — see
 *   {@link DNS_1123_LABEL_MAX_LENGTH} and {@link DNS_1123_SUBDOMAIN_MAX_LENGTH}.
 *   Must leave room for the hash suffix (at least {@link SHORT_HASH_LENGTH} + 1
 *   characters). Default: {@link DNS_1123_LABEL_MAX_LENGTH}
 * @returns The name unchanged when it fits, otherwise a truncated,
 *   hash-suffixed form of at most `maxLength` characters
 *
 * @example
 * ```typescript
 * toBoundedName("cnpg-grants-analytics"); // unchanged — it already fits
 * toBoundedName("a".repeat(80)); // "aaa…a-3e2f1c7d" — 63 characters
 * ```
 */
export function toBoundedName(name: string, maxLength: number = DNS_1123_LABEL_MAX_LENGTH): string {
  if (name.length <= maxLength) {
    return name;
  }
  const head = name.slice(0, maxLength - SHORT_HASH_LENGTH - 1).replace(EDGE_SEPARATORS, "");
  // A budget small enough to erase the head still has to produce a valid
  // DNS-1123 name, and a bare `-`-prefixed hash is not one.
  return head === "" ? shortHash(name) : `${head}-${shortHash(name)}`;
}

/**
 * Derive a Kubernetes label *value* from a raw identifier.
 *
 * Label values are far more restricted than the identifiers engines accept: the
 * shared role-name validator deliberately permits `reporting@corp`, and `@` is
 * not a legal label character, so the raw name would be rejected by the
 * Kubernetes API when the object carrying the label is applied — after preview
 * has passed and, for a Job, before it can ever run. Values are additionally
 * capped at {@link DNS_1123_LABEL_MAX_LENGTH} characters, which is what
 * {@link toBoundedName} enforces here.
 *
 * The raw identifier must still be used everywhere it has to be exact: the SQL
 * or Cypher statement that creates the account, and the Secret payload
 * applications authenticate with. This is for labels only.
 *
 * @param value - Raw identifier as it exists in the database engine
 * @returns A valid label value, truncated with a hash suffix when over-long
 */
export function toLabelValue(value: string): string {
  return toBoundedName(toIdentitySegment(value));
}
