# Declarative Database Roles — Design

**Status:** Approved, awaiting implementation plan
**Date:** 2026-07-30
**Target release:** `@reyemtech/nimbus` 3.0.0 (major)
**Cluster context:** `reyemtech-iad-1` — CNPG 1.30.0 (`pgsql-main`), mariadb-operator (`mariadb-main`), Neo4j Community (`neo4j-main`, `hivepipe-neo4j`)

## Problem

nimbus models exactly one role per database — the owner, created as a side effect of
`createDatabase()`. Every additional role a real deployment needs (a read-only reporting
user, a separate ETL identity, a scoped app account) has to be created out-of-band in SQL.

That out-of-band SQL exists today and documents its own pain. `corp-data-layer`'s
`shared/scripts/bootstrap-roles.sql`, `bootstrap-chamber.sql` and `bootstrap-ledger.sql`
each hand-roll the same pattern, and the header comment of the first explains why it is
awkward:

> psql does NOT perform `:'var'` interpolation inside dollar-quoted bodies, so the password
> could never reach the `CREATE ROLE` statement that way

The consequences:

1. **Passwords are plumbed by hand.** `format(%L)` + `\gexec` exists solely to get a password
   into `CREATE ROLE`. Values are passed as `psql -v` variables sourced from env, and must be
   kept in sync with a Kubernetes Secret that something else creates.
2. **Rotation silently does not happen.** The idempotency guard is `WHERE NOT EXISTS`, so on
   re-run an existing role is skipped entirely and its password drifts from the Secret
   forever.
3. **Provisioning is split across two systems** with no shared vocabulary — Pulumi owns the
   database and the owner, SQL files own everything else.
4. **Each engine is different.** CNPG, MariaDB and Neo4j expose three unrelated shapes, so
   there is no single thing to learn.

`bootstrap-laravel-reader.sql` is the clearest case: it creates one MySQL user and grants
`SELECT` on four named tables, with a `CHANGE_ME` password placeholder that a human must
remember to substitute — despite the mariadb-operator modelling all of that declaratively
in CRDs nimbus already installs.

## Goals

- One method, `addRole()`, with identical semantics and an identical return shape on every
  engine nimbus supports.
- Role identity, password generation, and Secret replication owned by nimbus and reconciled
  — never hand-plumbed, and rotation works.
- Portable grants for the cases that genuinely map across engines, with removal working
  (declarative, not merely additive).
- An escape hatch for engine-specific SQL that the model does not cover.
- An upgrade to 3.0.0 that requires no user code changes and no manual state surgery.

## Non-Goals

- **Modelling the whole PostgreSQL privilege system.** Column-level grants, function
  `EXECUTE`, sequence privileges, `REVOKE … FROM PUBLIC`, and row-level security stay in the
  `sql` escape hatch.
- **Continuous reconciliation of generated-SQL grants.** Grants applied by Job converge on
  `pulumi up`, not continuously. No CronJob. (See Deferred.)
- **Neo4j RBAC.** The cluster runs Community, where roles do not exist.
- **Making Neo4j declarative.** It has no operator and no CRDs; it keeps a `cypher-shell` Job.
- **Migrating existing bootstrap SQL automatically.** Rewriting `corp-data-layer`'s scripts
  onto the new API is follow-up work in that repo, not part of this change.

## Background: what each operator can actually express

Established by reading CRD schemas on the live cluster and the CloudNativePG controller
source (`internal/management/controller/database_controller_sql.go`, release-1.30 and `main`).

| | identity + password | memberships | privileges |
| --- | --- | --- | --- |
| **CNPG** | `DatabaseRole` CR | `spec.inRoles` | **not modelled** |
| **MariaDB** | `User` CR | not modelled | `Grant` CR |
| **Neo4j (Community)** | `cypher-shell` Job | n/a | n/a |

Two findings drive the design:

- **CNPG cannot express grants.** In the `Database` CRD, `SchemaSpec` is `{name, ensure, owner}`
  — ownership only. The single `UsageSpec` (`grant`/`revoke`) in the API hangs off FDWs and
  foreign servers. This holds on `main`, not just 1.30, so it is not a version gap.
- **CNPG and MariaDB are complementary opposites.** MariaDB models grants declaratively but
  not memberships; CNPG models memberships but not grants.

Therefore the only universally declarative layer is identity + credentials. Grants are
uniform at the **API** level and divergent at the **mechanism** level.

## Architecture

```
db.addRole("reader", { grants: [...], engineOptions: {...} })
  │
  ├─ identity ──── CNPG      → DatabaseRole CR
  │                MariaDB   → User CR
  │                Neo4j     → cypher-shell Job
  │
  ├─ grants ────── CNPG      → generated SQL, reconciled by Job (as database owner)
  │                MariaDB   → Grant CRs (one per entry)
  │                Neo4j     → rejected at build time
  │
  ├─ sql ───────── all       → same Job, applied after grants
  │
  └─ secrets ───── all       → per-namespace connection Secret (host/port/user/pw/db/uri)
```

Apply order within a database is fixed: **roles → database → grants → sql**.

## Component Contracts

### `IDatabaseRoleConfig`

```typescript
/** Privilege grant, portable across engines that model privileges. */
export interface IDatabaseGrant {
  /** Privileges to grant (e.g. ["SELECT"], ["SELECT", "INSERT"]). */
  readonly privileges: string[];
  /** Schema to scope to. PostgreSQL only; ignored by engines without schemas. */
  readonly schema?: string;
  /** Specific object, or every current and future object when "all". Default: "all". */
  readonly objects?: string | "all";
}

/** Configuration for a role created via addRole(). */
export interface IDatabaseRoleConfig {
  /** Namespaces to replicate the credential Secret into. */
  readonly namespaces?: string[];
  /** Whether the role can log in. Default: true. */
  readonly login?: boolean;
  /** Privileges granted to this role on the owning database. */
  readonly grants?: IDatabaseGrant[];
  /** End-of-life policy for the role. Default: "retain". */
  readonly reclaimPolicy?: ReclaimPolicy;
  /** Engine-specific options that do not port across engines. */
  readonly engineOptions?: {
    readonly postgresql?: {
      readonly inRoles?: string[];
      readonly connectionLimit?: number;
      readonly validUntil?: string;
    };
    readonly mariadb?: {
      readonly host?: string;
      readonly maxUserConnections?: number;
    };
  };
}

/** A role provisioned within a database. */
export interface IDatabaseRole {
  readonly name: string;
  readonly databaseName: string;
  readonly clusterName: string;
  /** Secrets created in target namespaces (namespace → secret name). */
  readonly secrets: Record<string, pulumi.Output<string>>;
  readonly nativeResource: pulumi.Resource;
}
```

`inRoles` is deliberately **not** promoted to the common surface despite being the most
useful PostgreSQL field. MariaDB has no equivalent, so a shared `inRoles` would be a field
that silently does nothing on one engine. The same reasoning excludes `host` (MariaDB-only).
A field appears in the common surface only when every engine can honour it.

### `IDatabaseInstance.addRole()`

```typescript
addRole(name: string, config?: IDatabaseRoleConfig): IDatabaseRole;
```

Required on `IDatabaseInstance`, implemented by all three backends. This is the breaking
change that makes the release a major.

### `IOperatorDatabaseConfig.sql`

```typescript
/**
 * Extra SQL applied after grants, as the database owner. Statements MUST be
 * idempotent — the Job re-runs whenever the content checksum changes.
 */
readonly sql?: string[];
```

### `objects: "all"` — portable future-object semantics

The most important grant case is "every table in this schema, including ones created later,"
because dbt and Laravel create tables at runtime. Both engines express it, differently:

| Engine | Compiles to |
| --- | --- |
| MariaDB | `GRANT <privs> ON <db>.* TO '<user>'@'<host>'` — database-level privileges already cover later tables |
| PostgreSQL | `GRANT <privs> ON ALL TABLES IN SCHEMA <schema> TO <role>` **and** `ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA <schema> GRANT <privs> ON TABLES TO <role>` |

nimbus supplies the `FOR ROLE <owner>` clause from the database owner it already knows —
the detail `bootstrap-roles.sql` has to spell out by hand as `FOR ROLE reyem_etl`.

### CNPG grant reconciliation

Grants are applied by a Job that **reconciles**, rather than a script that appends:

1. Connect as the **database owner**, using the owner's existing credential Secret. Never
   superuser.
2. Query `information_schema.role_table_grants` and `information_schema.usage_privileges`
   for privileges held by roles nimbus manages on this database.
3. Diff against the desired spec.
4. Issue `GRANT` for additions and `REVOKE` for removals.

Scoping to nimbus-managed roles is what makes revocation tractable — the Job never touches a
privilege it did not create, so it cannot strip a hand-granted privilege on an unrelated
role. Identifiers are emitted through a quoting helper; no string interpolation into SQL.

The Job re-runs when the checksum of (grants + sql) changes. It does not run continuously,
so a hand-typed `REVOKE` persists until the next `pulumi up`.

### Neo4j

`addRole()` creates a user via `cypher-shell` and replicates a Secret. Passing `grants` to a
Neo4j database **throws at build time** rather than being ignored. This also fixes
`src/operator/neo4j.ts:429`, where `GRANT ROLE reader, editor … || true` currently swallows
the Enterprise-only failure silently.

### `createDatabase()` collapses onto `addRole()`

The owner role becomes an internal `addRole(owner, { login: true })` followed by database
creation and ownership assignment. Each backend loses its duplicated role-creation branch —
one code path for "provision an identity and hand back a Secret," used by both the owner and
every additional role.

This is not only a tidiness win: it is what makes the upgrade unattended. `addRole()` emits
the same resources under the same logical names that `createDatabase()` emitted before, so
existing call sites compile unchanged **and** produce an identical Pulumi plan. The
refactor is observable only in the code, not in the state file.

## Known Limitations

- **`ALTER ROLE … SET <guc>` is not reachable.** PostgreSQL permits a non-superuser to alter
  only its own settings, and the Job runs as the database owner. `DatabaseRole` has no GUC
  field either. So `ALTER ROLE reyem_reader SET default_transaction_read_only = on` requires
  `superuserAccess: true` or stays manual. Practical impact is low: `pg_read_all_data` grants
  `SELECT` and nothing else, so read-only is already enforced by privilege; the GUC is
  belt-and-braces. Documented, not worked around.
- **Deploy-time ordering.** A Job cannot grant `USAGE` on a schema that does not exist yet.
  `objects: "all"` sidesteps this for future *tables* via `ALTER DEFAULT PRIVILEGES`, but not
  for schemas created at runtime. `bootstrap-roles.sql` warns about the same hazard today.
- **Grants converge, they do not reconcile continuously.** See Non-Goals.

## Versioning and Migration

3.0.0 — but it is worth being exact about *why*, because the feature itself is backwards
compatible.

| Change | Breaking? |
| --- | --- |
| `addRole()`, `grants`, `sql` added | No — purely additive |
| `createDatabase()` reimplemented on `addRole()` | No — identical resources and logical names |
| MariaDB / Neo4j refactor onto the shared path | No, **provided** every rename ships an alias |
| `addRole()` required on `IDatabaseInstance` | Type-only, for code that *implements* the interface — realistically test mocks |
| `superuserAccess` defaulting `false` | **Yes** — mutates live cluster state |

So the API is backwards compatible and the upgrade is unattended. The major is driven by one
behavioural change: flipping `enableSuperuserAccess` makes CNPG set the `postgres` password
to `NULL` and delete `{cluster}-superuser`. No alias or shim can make that a no-op, and it is
the only item in the table a user could be surprised by.

That isolation opens an alternative worth deciding explicitly: ship the entire feature as
**2.13.0** (additive, unattended, `addRole?()` optional) and defer only the `superuserAccess`
default to 3.0.0. The cost is that `addRole()` stays optional — every call site needs `?.` —
which undercuts the "one way to create access" goal that motivated standardising across
engines in the first place. This design assumes the single-major path; see Open Items.

The upgrade must require no user action. Three mechanisms deliver that:

### 1. Pulumi aliases (release blocker)

Refactoring MariaDB and Neo4j onto the shared path renames the logical names passed to
Pulumi resource constructors. Pulumi reads a rename as **delete + create**; for a credential
Secret that means regenerated passwords and broken applications on a routine upgrade.

Every renamed resource ships an alias inside the library:

```typescript
new k8s.core.v1.Secret(
  `${clusterName}-${dbName}-role-secret`,
  { /* ... */ },
  { provider, aliases: [{ name: `${clusterName}-${dbName}-user-secret` }] }
);
```

**A renamed resource without an alias is a release blocker.** Verification is a
`pulumi preview` against a stack on the previous version showing zero `replace` operations.

The CNPG work already merged is alias-clean: `-user-secret`, `-user-secret-read` and
`-secret-${ns}` kept their names; only the Job was removed and three resources added.

### 2. CRD adoption

Verified rather than assumed. `reconcilePostgresDatabase` calls `detectDatabase` and, when
the database exists, takes `updateDatabase` — which emits `ALTER` only for explicitly-set
fields plus `ALTER DATABASE … OWNER TO`. `DatabaseRole` adopts existing roles the same way.

Checked against the live cluster: all six `pgsql-main` roles report
`login=t, super=f, createdb=f, createrole=f, inherit=t, connlimit=-1, bypassrls=f, memberof={}`
— exactly what the generated manifest declares — and every database owner already matches.
Adoption is a genuine no-op.

### 3. `npx @reyemtech/nimbus migrate v3` — read-only pre-flight

Deliberately **non-mutating**. A migration tool that rewrites Pulumi state or touches a live
database is excellent 95% of the time and catastrophic otherwise, and here it would add
little: the aliases do the actual work.

It checks and reports:

- role attributes and database ownership against what the CRDs will assert (the queries in
  `docs/cnpg-declarative-databases.md`);
- references to `{cluster}-superuser` anywhere in the repo;
- `pulumi preview` output for unexpected `replace` operations.

Exits non-zero on anything unsafe; suitable for CI. Lands as a fourth command alongside
`new`, `install`, `check` in `src/cli.ts`.

### `superuserAccess`

3.0.0 ships the secure default (`false`). The behavioural change — CNPG sets the `postgres`
password to `NULL` and deletes `{cluster}-superuser` — is the one thing no alias can make a
no-op. `migrate v3` fails loudly when it finds consumers of that Secret, so the risk surfaces
before `pulumi up` rather than after.

## Testing

`src/operator/**` is excluded from coverage in `vitest.config.ts` (integration-tested
separately), but the SQL compiler is pure and must not follow that convention.

### Unit tests (new, required)

- `tests/unit/operator/grant-sql.test.ts` — the `IDatabaseGrant[]` → SQL compiler:
  `objects: "all"` emitting both the `GRANT … ON ALL TABLES` and `ALTER DEFAULT PRIVILEGES`
  statements; identifier quoting for names containing quotes, hyphens and mixed case;
  multi-privilege and multi-schema entries; empty array producing no Job at all.
- `tests/unit/operator/grant-diff.test.ts` — desired-vs-actual: additions produce `GRANT`,
  removals produce `REVOKE`, unchanged entries produce nothing, and privileges held by roles
  outside nimbus's scope are never emitted.
- `tests/unit/operator/role-config.test.ts` — defaults (`login` true, `reclaimPolicy`
  `"retain"`), and that `grants` against Neo4j throws.

### Manual cluster verification

- `kubectl get databaseroles,databases -n data` reports `APPLIED: true`.
- Application credentials unchanged after upgrade (compare Secret `password` before/after).
- `pulumi preview` on a pre-3.0 stack shows zero `replace`.

## Sequencing

Independently shippable, in order:

1. **CNPG `addRole()`** — builds directly on the merged `DatabaseRole`/`Database` work.
2. **Grant compiler + reconciling Job** — pure logic first, then the Job that runs it.
3. **MariaDB** — mostly reshaping existing `User`/`Grant` code; aliases mandatory.
4. **Neo4j** — `addRole()` via the existing Job; fix the swallowed `GRANT ROLE` failure.
5. **`migrate v3` + `docs/migrations/v3.md`** — ships with the major.

## Deferred

- **Continuous grant reconciliation** via CronJob. Adds a permanently scheduled workload per
  cluster and lets grants change between deploys. Revisit if drift proves real.
- **`ALTER ROLE … SET` support**, pending a CNPG `DatabaseRole` GUC field upstream.
- **Rewriting `corp-data-layer`'s bootstrap SQL** onto the new API — separate repo, separate
  change, once 3.0.0 is released.

## Open Items for Plan Phase

- Exact `information_schema` queries for the diff, including how `USAGE ON SCHEMA` is read
  back (it is not in `role_table_grants`).
- Whether the reconciling Job is one per database or one per cluster.
- Whether `objects` should accept an array of object names, or stay `string | "all"` in v1.
- Full inventory of renamed resources requiring aliases, produced during the MariaDB and
  Neo4j refactors.
- **Single major vs. split release.** This design assumes 3.0.0 carries both the feature and
  the `superuserAccess` default. The alternative — 2.13.0 for the feature with `addRole?()`
  optional, 3.0.0 for the default flip — makes the feature release fully unattended at the
  cost of an optional method on every call site. Decide before the plan phase.
