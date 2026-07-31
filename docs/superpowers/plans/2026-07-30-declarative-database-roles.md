# Declarative Database Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a uniform `addRole()` to every database backend in nimbus, so additional database roles/users are provisioned declaratively with generated passwords and replicated Secrets, instead of by hand-written bootstrap SQL.

**Architecture:** One method on `IDatabaseInstance`, three backend implementations. Identity is declarative where the operator supports it (CNPG `DatabaseRole`, MariaDB `User`) and Job-based where it does not (Neo4j `cypher-shell`). Portable `grants` compile to `Grant` CRs on MariaDB and to generated SQL applied by a reconciling Job on CNPG. Shared credential handling (password generation, stable read-back, namespace Secret replication) is extracted into one module used by all three backends, and `createDatabase()` is reimplemented on top of `addRole()` so both paths share one code path.

**Tech Stack:** TypeScript (Node16 ESM+CJS dual build), Pulumi (`@pulumi/pulumi`, `@pulumi/kubernetes`), vitest, eslint, prettier.

## Global Constraints

- **Import paths use `.js` extensions** — `import { x } from "./grants/postgres-sql.js"` — required for Node16 module resolution.
- **`import type` for type-only imports** — enforced by eslint.
- **No `any`** — `@typescript-eslint/no-explicit-any` is `error`. Use `unknown` + type guards.
- **Interfaces prefixed `I`**, types PascalCase, constants UPPER_SNAKE_CASE, files kebab-case.
- **`readonly` on all interface properties.**
- **No file exceeds 500 lines.**
- **Explicit return types on all exported functions.**
- **TypeDoc on every public export**, with `@throws` where a function throws.
- **Prettier:** double quotes, semicolons, 100-char print width, es5 trailing commas.
- **Every renamed Pulumi resource MUST ship `aliases`.** A rename without an alias is a release blocker — Pulumi reads it as delete+create, which regenerates credential Secrets and breaks running applications.
- **Never interpolate user-supplied strings into SQL.** Identifiers go through `quoteIdentifier()`; privilege keywords go through `normalizePrivilege()` allowlist validation.
- **Run before every commit:** `npm run format:check && npm run lint && npm run typecheck && npm run test:coverage`

## File Structure

| File | Responsibility |
| --- | --- |
| `src/operator/interfaces.ts` (modify) | Add `IDatabaseGrant`, `IDatabaseRoleConfig`, `IDatabaseRole`; add `addRole()` to `IDatabaseInstance` |
| `src/operator/role-config.ts` (create) | Pure defaults resolution + validation for `IDatabaseRoleConfig` |
| `src/operator/grants/postgres-sql.ts` (create) | Pure: identifier quoting, privilege allowlist, grant→SQL compiler |
| `src/operator/grants/postgres-job.ts` (create) | Pulumi Job resource that applies the compiled SQL as the database owner |
| `src/operator/credentials.ts` (create) | Shared: password generation, user Secret, stable read-back, namespace replication |
| `src/operator/cnpg.ts` (modify) | `addRole()` via `DatabaseRole` CR; `createDatabase()` reimplemented on it |
| `src/operator/mariadb.ts` (modify) | `addRole()` via `User`+`Grant` CRs; `createDatabase()` reimplemented on it |
| `src/operator/neo4j.ts` (modify) | `addRole()` via `cypher-shell` Job; throw on `grants`; fix swallowed `GRANT ROLE` |
| `src/cli.ts` (modify) | Add `migrate` command |
| `src/cli/migrate.ts` (create) | Read-only v3 pre-flight checks |
| `vitest.config.ts` (modify) | Narrow coverage exclude so `src/operator/grants/**` and `role-config.ts` are covered |
| `tests/unit/operator/postgres-sql.test.ts` (create) | Compiler + quoting + allowlist tests |
| `tests/unit/operator/role-config.test.ts` (create) | Defaults and validation tests |
| `docs/migrations/v3.md` (create) | Migration guide |

**Superseded spec open item:** the spec left "exact `information_schema` queries for the diff" open. Resolved: **there is no diff.** Schema-level `USAGE` is not exposed in `information_schema` (it lives in `pg_namespace.nspacl`), so a diff would need `has_schema_privilege()` plumbing and a record of prior state. Instead the Job runs an atomic **revoke-then-grant** inside a single transaction: discover every schema on which the managed role currently holds `USAGE`, revoke all its privileges there, then apply the desired grants. Self-correcting, needs no prior-state storage, and removal works because anything not re-granted stays revoked.

---

### Task 1: Role interfaces and config defaults

**Files:**
- Modify: `src/operator/interfaces.ts`
- Create: `src/operator/role-config.ts`
- Create: `tests/unit/operator/role-config.test.ts`
- Modify: `vitest.config.ts:20`

**Interfaces:**
- Consumes: `ReclaimPolicy` from `src/operator/interfaces.ts` (already exists)
- Produces: `IDatabaseGrant`, `IDatabaseRoleConfig`, `IDatabaseRole`, `IDatabaseInstance.addRole()`, and `resolveRoleConfig(config?: IDatabaseRoleConfig): IResolvedRoleConfig` where `IResolvedRoleConfig = { login: boolean; grants: IDatabaseGrant[]; reclaimPolicy: ReclaimPolicy; namespaces: string[] }`

- [ ] **Step 1: Narrow the coverage exclude**

In `vitest.config.ts`, change the exclude entry `"src/operator/**"` to `"src/operator/*.ts"`. This keeps the backend implementation files excluded (they are integration-tested separately) while allowing `src/operator/grants/**` to be measured. Then add `"!src/operator/role-config.ts"` is NOT valid vitest syntax — instead, leave `src/operator/*.ts` and move nothing; `role-config.ts` will remain excluded by that glob. To cover it, place it at `src/operator/grants/role-config.ts` instead.

**Corrected decision:** create the file at `src/operator/grants/role-config.ts` so one exclude change covers both new pure modules. All later references in this plan use `src/operator/grants/role-config.ts`.

```typescript
// vitest.config.ts — exclude list
exclude: [
  "src/**/index.ts",
  "src/**/interfaces.ts",
  "src/aws/**",
  "src/azure/**",
  "src/global-lb/glb.ts",
  "src/platform/stack.ts",
  "src/observability/stack.ts",
  "src/observability/dashboards.ts",
  "src/backup/**",
  "src/operator/*.ts",
  "src/cache/cache.ts",
  "src/cli.ts",
  "src/cli/**",
],
```

- [ ] **Step 2: Add the interfaces**

Append to `src/operator/interfaces.ts`, after the `ReclaimPolicy` type:

```typescript
/**
 * A privilege grant on a database, portable across engines that model privileges.
 *
 * @example Read-only access to every current and future table in a schema
 * ```typescript
 * { privileges: ["SELECT"], schema: "marts", objects: "all" }
 * ```
 */
export interface IDatabaseGrant {
  /** Privileges to grant (e.g. ["SELECT"], ["SELECT", "INSERT"]). */
  readonly privileges: string[];
  /** Schema to scope the grant to. PostgreSQL only; ignored by engines without schemas. */
  readonly schema?: string;
  /** A specific object name, or every current and future object when "all". Default: "all". */
  readonly objects?: string;
}

/** Configuration for a role created via {@link IDatabaseInstance.addRole}. */
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
      /** Existing roles this role becomes a member of (e.g. ["pg_read_all_data"]). */
      readonly inRoles?: string[];
      /** Maximum concurrent connections. Default: unlimited. */
      readonly connectionLimit?: number;
      /** Timestamp after which the password expires. */
      readonly validUntil?: string;
    };
    readonly mariadb?: {
      /** Host pattern the user may connect from. Default: "%". */
      readonly host?: string;
      /** Maximum concurrent connections. Default: 100. */
      readonly maxUserConnections?: number;
    };
  };
}

/** A role provisioned within a database. */
export interface IDatabaseRole {
  /** Role name as it exists in the database engine. */
  readonly name: string;
  /** Database this role was created for. */
  readonly databaseName: string;
  /** Cluster the database belongs to. */
  readonly clusterName: string;
  /** Secrets created in target namespaces (namespace → secret name). */
  readonly secrets: Record<string, pulumi.Output<string>>;
  /** Underlying Pulumi resource for dependency wiring. */
  readonly nativeResource: pulumi.Resource;
}
```

Then add to the `IDatabaseInstance` interface, after `nativeResource`:

```typescript
  /**
   * Create an additional role/user on this database with a generated password,
   * replicating a connection Secret into the given namespaces.
   *
   * @param name - Role name as it will exist in the database engine
   * @param config - Namespaces, login flag, grants, and engine-specific options
   * @returns The provisioned role with its replicated Secret references
   * @throws {AnyCloudError} with code `UNSUPPORTED_ROLE_OPTION` when `grants` is
   *   passed to an engine that cannot express privileges (Neo4j Community).
   */
  addRole(name: string, config?: IDatabaseRoleConfig): IDatabaseRole;
```

- [ ] **Step 3: Write the failing test**

Create `tests/unit/operator/role-config.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { resolveRoleConfig } from "../../../src/operator/grants/role-config.js";

describe("resolveRoleConfig", () => {
  it("defaults login to true", () => {
    const resolved = resolveRoleConfig();
    expect(resolved.login).toBe(true);
  });

  it("defaults reclaimPolicy to retain", () => {
    const resolved = resolveRoleConfig();
    expect(resolved.reclaimPolicy).toBe("retain");
  });

  it("defaults namespaces and grants to empty arrays", () => {
    const resolved = resolveRoleConfig();
    expect(resolved.namespaces).toEqual([]);
    expect(resolved.grants).toEqual([]);
  });

  it("preserves explicit login false", () => {
    expect(resolveRoleConfig({ login: false }).login).toBe(false);
  });

  it("preserves explicit values", () => {
    const resolved = resolveRoleConfig({
      namespaces: ["apps"],
      reclaimPolicy: "delete",
      grants: [{ privileges: ["SELECT"], schema: "marts" }],
    });
    expect(resolved.namespaces).toEqual(["apps"]);
    expect(resolved.reclaimPolicy).toBe("delete");
    expect(resolved.grants).toHaveLength(1);
  });

  it("rejects an empty role name at the call boundary", () => {
    expect(() => resolveRoleConfig({ grants: [{ privileges: [] }] })).toThrow(
      /at least one privilege/i
    );
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `npx vitest run tests/unit/operator/role-config.test.ts`
Expected: FAIL — cannot resolve `../../../src/operator/grants/role-config.js`

- [ ] **Step 5: Implement**

Create `src/operator/grants/role-config.ts`:

```typescript
/**
 * Pure defaults resolution and validation for database role configuration.
 *
 * @module operator/grants/role-config
 */

import { AnyCloudError } from "../../types/errors.js";
import type { IDatabaseGrant, IDatabaseRoleConfig, ReclaimPolicy } from "../interfaces.js";

/** Role configuration with all defaults applied. */
export interface IResolvedRoleConfig {
  readonly login: boolean;
  readonly grants: ReadonlyArray<IDatabaseGrant>;
  readonly reclaimPolicy: ReclaimPolicy;
  readonly namespaces: ReadonlyArray<string>;
}

const DEFAULT_LOGIN = true;
const DEFAULT_RECLAIM_POLICY: ReclaimPolicy = "retain";

/**
 * Apply defaults to a role config and validate its grants.
 *
 * @param config - Raw user-supplied configuration
 * @returns Configuration with every optional field resolved
 * @throws {AnyCloudError} code `INVALID_GRANT` when a grant lists no privileges
 */
export function resolveRoleConfig(config?: IDatabaseRoleConfig): IResolvedRoleConfig {
  const grants = config?.grants ?? [];

  for (const grant of grants) {
    if (grant.privileges.length === 0) {
      throw new AnyCloudError(
        "Each grant must list at least one privilege.",
        "INVALID_GRANT"
      );
    }
  }

  return {
    login: config?.login ?? DEFAULT_LOGIN,
    grants,
    reclaimPolicy: config?.reclaimPolicy ?? DEFAULT_RECLAIM_POLICY,
    namespaces: config?.namespaces ?? [],
  };
}
```

Check the exact `AnyCloudError` constructor signature in `src/types/errors.ts` before writing — if it takes `(code, message)` rather than `(message, code)`, match the existing order and update the test accordingly.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/unit/operator/role-config.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 7: Full check and commit**

```bash
npm run format && npm run lint && npm run typecheck && npm run test:coverage
git add src/operator/interfaces.ts src/operator/grants/role-config.ts tests/unit/operator/role-config.test.ts vitest.config.ts
git commit -m "feat(operator): add role interfaces and config defaults"
```

Note: `npm run typecheck` WILL fail at this point if `addRole()` was added as required to `IDatabaseInstance` before any backend implements it. If so, temporarily mark it optional (`addRole?`) in this commit and make it required in Task 8 once all three backends implement it. Record which you did — Task 8 depends on it.

---

### Task 2: PostgreSQL grant SQL compiler

**Files:**
- Create: `src/operator/grants/postgres-sql.ts`
- Create: `tests/unit/operator/postgres-sql.test.ts`

**Interfaces:**
- Consumes: `IDatabaseGrant` from `src/operator/interfaces.ts`
- Produces:
  - `quoteIdentifier(name: string): string`
  - `normalizePrivilege(privilege: string): string`
  - `compileGrantSql(options: ICompileOptions): string` where
    `ICompileOptions = { role: string; owner: string; grants: ReadonlyArray<IDatabaseGrant>; extraSql?: ReadonlyArray<string> }`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/operator/postgres-sql.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  quoteIdentifier,
  normalizePrivilege,
  compileGrantSql,
} from "../../../src/operator/grants/postgres-sql.js";

describe("quoteIdentifier", () => {
  it("wraps a plain identifier in double quotes", () => {
    expect(quoteIdentifier("marts")).toBe('"marts"');
  });

  it("escapes embedded double quotes by doubling them", () => {
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });

  it("preserves hyphens and mixed case without mangling", () => {
    expect(quoteIdentifier("App-Reader")).toBe('"App-Reader"');
  });

  it("neutralises an injection attempt", () => {
    expect(quoteIdentifier('x"; DROP DATABASE prod; --')).toBe(
      '"x""; DROP DATABASE prod; --"'
    );
  });
});

describe("normalizePrivilege", () => {
  it("uppercases a known privilege", () => {
    expect(normalizePrivilege("select")).toBe("SELECT");
  });

  it("accepts multi-word ALL PRIVILEGES", () => {
    expect(normalizePrivilege("all privileges")).toBe("ALL PRIVILEGES");
  });

  it("rejects an unknown keyword rather than emitting it", () => {
    expect(() => normalizePrivilege("DROP DATABASE")).toThrow(/unsupported privilege/i);
  });
});

describe("compileGrantSql", () => {
  it("wraps everything in a single transaction", () => {
    const sql = compileGrantSql({ role: "reader", owner: "etl", grants: [] });
    expect(sql.trimStart().startsWith("BEGIN;")).toBe(true);
    expect(sql.trimEnd().endsWith("COMMIT;")).toBe(true);
  });

  it("revokes existing privileges before granting", () => {
    const sql = compileGrantSql({
      role: "reader",
      owner: "etl",
      grants: [{ privileges: ["SELECT"], schema: "marts", objects: "all" }],
    });
    expect(sql.indexOf("REVOKE")).toBeLessThan(sql.indexOf("GRANT SELECT"));
  });

  it("emits ALL TABLES plus ALTER DEFAULT PRIVILEGES for objects: all", () => {
    const sql = compileGrantSql({
      role: "reader",
      owner: "etl",
      grants: [{ privileges: ["SELECT"], schema: "marts", objects: "all" }],
    });
    expect(sql).toContain('GRANT USAGE ON SCHEMA "marts" TO "reader";');
    expect(sql).toContain('GRANT SELECT ON ALL TABLES IN SCHEMA "marts" TO "reader";');
    expect(sql).toContain(
      'ALTER DEFAULT PRIVILEGES FOR ROLE "etl" IN SCHEMA "marts" GRANT SELECT ON TABLES TO "reader";'
    );
  });

  it("defaults objects to all when omitted", () => {
    const sql = compileGrantSql({
      role: "reader",
      owner: "etl",
      grants: [{ privileges: ["SELECT"], schema: "marts" }],
    });
    expect(sql).toContain("ON ALL TABLES IN SCHEMA");
  });

  it("targets a single table when objects names one", () => {
    const sql = compileGrantSql({
      role: "reader",
      owner: "etl",
      grants: [{ privileges: ["SELECT"], schema: "marts", objects: "orders" }],
    });
    expect(sql).toContain('GRANT SELECT ON "marts"."orders" TO "reader";');
    expect(sql).not.toContain("ALL TABLES");
  });

  it("joins multiple privileges in one statement", () => {
    const sql = compileGrantSql({
      role: "app",
      owner: "etl",
      grants: [{ privileges: ["SELECT", "INSERT"], schema: "public", objects: "all" }],
    });
    expect(sql).toContain('GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA "public" TO "app";');
  });

  it("emits statements for every schema in a multi-entry grant list", () => {
    const sql = compileGrantSql({
      role: "reader",
      owner: "etl",
      grants: [
        { privileges: ["SELECT"], schema: "marts", objects: "all" },
        { privileges: ["SELECT"], schema: "staging", objects: "all" },
      ],
    });
    expect(sql).toContain('IN SCHEMA "marts"');
    expect(sql).toContain('IN SCHEMA "staging"');
  });

  it("appends extra SQL after the grants", () => {
    const sql = compileGrantSql({
      role: "reader",
      owner: "etl",
      grants: [{ privileges: ["SELECT"], schema: "marts", objects: "all" }],
      extraSql: ["CREATE EXTENSION IF NOT EXISTS pg_trgm;"],
    });
    expect(sql.indexOf("CREATE EXTENSION")).toBeGreaterThan(sql.indexOf("GRANT SELECT"));
  });

  it("quotes a role name containing a quote", () => {
    const sql = compileGrantSql({
      role: 'ro"le',
      owner: "etl",
      grants: [{ privileges: ["SELECT"], schema: "s", objects: "all" }],
    });
    expect(sql).toContain('TO "ro""le";');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/operator/postgres-sql.test.ts`
Expected: FAIL — cannot resolve `postgres-sql.js`

- [ ] **Step 3: Implement**

Create `src/operator/grants/postgres-sql.ts`:

```typescript
/**
 * Pure compiler from portable grant specs to PostgreSQL SQL.
 *
 * Emits an atomic revoke-then-grant script: every privilege the role currently
 * holds is revoked, then the desired grants are applied. This converges without
 * needing to introspect prior state, and removal works because anything not
 * re-granted stays revoked. The whole script runs in one transaction so no
 * window of missing privileges is ever observable.
 *
 * @module operator/grants/postgres-sql
 */

import { AnyCloudError } from "../../types/errors.js";
import type { IDatabaseGrant } from "../interfaces.js";

/** Privileges accepted in {@link IDatabaseGrant.privileges}. */
const ALLOWED_PRIVILEGES: ReadonlySet<string> = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
  "USAGE",
  "CREATE",
  "CONNECT",
  "TEMPORARY",
  "EXECUTE",
  "ALL PRIVILEGES",
]);

/** Sentinel meaning "every current and future object in the schema". */
const ALL_OBJECTS = "all";
const DEFAULT_SCHEMA = "public";

/** Options for {@link compileGrantSql}. */
export interface ICompileOptions {
  /** Role receiving the privileges. */
  readonly role: string;
  /** Database owner — the role whose future objects default privileges apply to. */
  readonly owner: string;
  /** Desired grants. An empty list revokes everything the role holds. */
  readonly grants: ReadonlyArray<IDatabaseGrant>;
  /** Raw SQL appended after the grants. Must be idempotent. */
  readonly extraSql?: ReadonlyArray<string>;
}

/**
 * Quote a PostgreSQL identifier, escaping embedded double quotes.
 *
 * @param name - Raw identifier
 * @returns The identifier wrapped in double quotes and safe to interpolate
 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Validate and normalise a privilege keyword.
 *
 * Privileges are SQL keywords and cannot be quoted, so they are checked against
 * an allowlist rather than escaped.
 *
 * @param privilege - Raw privilege name, any case
 * @returns The upper-cased privilege
 * @throws {AnyCloudError} code `UNSUPPORTED_PRIVILEGE` when not in the allowlist
 */
export function normalizePrivilege(privilege: string): string {
  const normalized = privilege.trim().toUpperCase().replace(/\s+/g, " ");
  if (!ALLOWED_PRIVILEGES.has(normalized)) {
    throw new AnyCloudError(
      `Unsupported privilege "${privilege}". Allowed: ${[...ALLOWED_PRIVILEGES].join(", ")}.`,
      "UNSUPPORTED_PRIVILEGE"
    );
  }
  return normalized;
}

/**
 * Compile a grant spec into an idempotent, transactional SQL script.
 *
 * @param options - Role, owner, desired grants, and optional trailing SQL
 * @returns A complete SQL script beginning with `BEGIN;` and ending `COMMIT;`
 * @throws {AnyCloudError} when a privilege is not in the allowlist
 */
export function compileGrantSql(options: ICompileOptions): string {
  const { role, owner, grants, extraSql = [] } = options;
  const qRole = quoteIdentifier(role);
  const qOwner = quoteIdentifier(owner);

  const statements: string[] = ["BEGIN;"];

  // Revoke every privilege the role currently holds, discovered at runtime.
  // format(%I) quotes identifiers; the role name is passed as a literal
  // parameter to has_schema_privilege rather than concatenated into DDL.
  statements.push(
    [
      "DO $nimbus$",
      "DECLARE s record;",
      "BEGIN",
      "  FOR s IN",
      "    SELECT nspname FROM pg_namespace",
      "    WHERE nspname NOT LIKE 'pg\\_%'",
      "      AND nspname <> 'information_schema'",
      `      AND has_schema_privilege(${quoteLiteral(role)}, nspname, 'USAGE')`,
      "  LOOP",
      `    EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA %I FROM %I', s.nspname, ${quoteLiteral(role)});`,
      `    EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA %I FROM %I', s.nspname, ${quoteLiteral(role)});`,
      `    EXECUTE format('REVOKE ALL ON SCHEMA %I FROM %I', s.nspname, ${quoteLiteral(role)});`,
      `    EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE ALL ON TABLES FROM %I', ${quoteLiteral(owner)}, s.nspname, ${quoteLiteral(role)});`,
      "  END LOOP;",
      "END",
      "$nimbus$;",
    ].join("\n")
  );

  for (const grant of grants) {
    const privileges = grant.privileges.map(normalizePrivilege).join(", ");
    const schema = grant.schema ?? DEFAULT_SCHEMA;
    const qSchema = quoteIdentifier(schema);
    const objects = grant.objects ?? ALL_OBJECTS;

    statements.push(`GRANT USAGE ON SCHEMA ${qSchema} TO ${qRole};`);

    if (objects === ALL_OBJECTS) {
      statements.push(`GRANT ${privileges} ON ALL TABLES IN SCHEMA ${qSchema} TO ${qRole};`);
      statements.push(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${qOwner} IN SCHEMA ${qSchema} ` +
          `GRANT ${privileges} ON TABLES TO ${qRole};`
      );
    } else {
      statements.push(
        `GRANT ${privileges} ON ${qSchema}.${quoteIdentifier(objects)} TO ${qRole};`
      );
    }
  }

  statements.push(...extraSql);
  statements.push("COMMIT;");

  return statements.join("\n");
}

/** Quote a string as a SQL literal. */
function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/unit/operator/postgres-sql.test.ts`
Expected: PASS (all describe blocks)

- [ ] **Step 5: Full check and commit**

```bash
npm run format && npm run lint && npm run typecheck && npm run test:coverage
git add src/operator/grants/postgres-sql.ts tests/unit/operator/postgres-sql.test.ts
git commit -m "feat(operator): add PostgreSQL grant SQL compiler"
```

---

### Task 3: Shared credential module

**Files:**
- Create: `src/operator/credentials.ts`

**Interfaces:**
- Produces:
  - `createRoleCredentials(options: IRoleCredentialOptions): IRoleCredentials` where
    `IRoleCredentials = { userSecret: k8s.core.v1.Secret; stablePassword: pulumi.Output<string>; secretName: string }`
  - `replicateConnectionSecrets(options: IReplicationOptions): Record<string, pulumi.Output<string>>`

This extracts the password-generate → store → read-back → replicate cycle duplicated across `cnpg.ts:86-114`, `mariadb.ts:75-94,151-159`, and `neo4j.ts:369-396`.

- [ ] **Step 1: Implement**

Create `src/operator/credentials.ts`:

```typescript
/**
 * Shared credential handling for database roles across all operator backends.
 *
 * Every backend needs the same cycle: generate a password, store it in a Secret
 * that Pulumi will not rewrite, read it back so the value is stable across
 * deploys, and replicate a connection Secret into consuming namespaces.
 *
 * @module operator/credentials
 */

import * as crypto from "node:crypto";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ensureNamespace } from "../utils/ensure-namespace.js";

const PASSWORD_BYTES = 24;

/** Options for {@link createRoleCredentials}. */
export interface IRoleCredentialOptions {
  /** Pulumi logical resource name for the Secret. */
  readonly resourceName: string;
  /** Kubernetes Secret name. */
  readonly secretName: string;
  /** Namespace to create the Secret in. */
  readonly namespace: string;
  /** Database username stored alongside the password. */
  readonly username: string;
  /** Labels applied to the Secret. */
  readonly labels: Record<string, string>;
  /** Kubernetes provider. */
  readonly provider: k8s.Provider;
  /** Resources the Secret must be created after. */
  readonly dependsOn: pulumi.Resource[];
  /** Optional Secret type (e.g. "kubernetes.io/basic-auth"). */
  readonly type?: string;
}

/** A stored credential plus a stable read-back of its password. */
export interface IRoleCredentials {
  readonly userSecret: k8s.core.v1.Secret;
  readonly stablePassword: pulumi.Output<string>;
  readonly secretName: string;
}

/**
 * Generate a password, store it, and read it back for stability across deploys.
 *
 * `ignoreChanges` on the stored Secret prevents Pulumi rewriting the password on
 * every run; the read-back is what downstream Secrets consume so the value stays
 * identical once created.
 *
 * @param options - Naming, labels, provider, and dependencies
 * @returns The Secret resource and a stable Output of its password
 */
export function createRoleCredentials(options: IRoleCredentialOptions): IRoleCredentials {
  const generatedPassword = pulumi.secret(
    crypto.randomBytes(PASSWORD_BYTES).toString("base64url")
  );

  const userSecret = new k8s.core.v1.Secret(
    options.resourceName,
    {
      metadata: {
        name: options.secretName,
        namespace: options.namespace,
        labels: options.labels,
      },
      ...(options.type ? { type: options.type } : {}),
      stringData: {
        username: options.username,
        password: generatedPassword,
      },
    },
    {
      provider: options.provider,
      dependsOn: options.dependsOn,
      ignoreChanges: ["data", "stringData"],
    }
  );

  const storedSecret = k8s.core.v1.Secret.get(
    `${options.resourceName}-read`,
    pulumi.interpolate`${options.namespace}/${options.secretName}`,
    { provider: options.provider, dependsOn: [userSecret] }
  );

  const stablePassword = storedSecret.data.apply((d) =>
    Buffer.from(d?.["password"] ?? "", "base64").toString()
  );

  return { userSecret, stablePassword, secretName: options.secretName };
}

/** Options for {@link replicateConnectionSecrets}. */
export interface IReplicationOptions {
  /** Namespaces to replicate into. */
  readonly namespaces: ReadonlyArray<string>;
  /** Pulumi logical resource name prefix. */
  readonly resourcePrefix: string;
  /** Kubernetes Secret name created in each namespace. */
  readonly secretName: string;
  /** Secret payload. */
  readonly stringData: Record<string, pulumi.Input<string>>;
  /** Labels applied to each Secret. */
  readonly labels: Record<string, string>;
  /** Kubernetes provider. */
  readonly provider: k8s.Provider;
  /** Resources each Secret must be created after. */
  readonly dependsOn: pulumi.Resource[];
  /** Optional per-resource aliases, keyed by namespace. */
  readonly aliasesByNamespace?: Record<string, string>;
}

/**
 * Create a connection Secret in each target namespace.
 *
 * @param options - Namespaces, payload, labels, and dependencies
 * @returns Map of namespace → created Secret name
 */
export function replicateConnectionSecrets(
  options: IReplicationOptions
): Record<string, pulumi.Output<string>> {
  const secrets: Record<string, pulumi.Output<string>> = {};

  for (const targetNs of options.namespaces) {
    const nsResource = ensureNamespace(targetNs, options.provider);
    const alias = options.aliasesByNamespace?.[targetNs];

    new k8s.core.v1.Secret(
      `${options.resourcePrefix}-${targetNs}`,
      {
        metadata: {
          name: options.secretName,
          namespace: targetNs,
          labels: options.labels,
        },
        stringData: options.stringData,
      },
      {
        provider: options.provider,
        dependsOn: [...options.dependsOn, nsResource],
        ...(alias ? { aliases: [{ name: alias }] } : {}),
      }
    );

    secrets[targetNs] = pulumi.output(options.secretName);
  }

  return secrets;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
npm run format && npm run lint && npm run typecheck
git add src/operator/credentials.ts
git commit -m "refactor(operator): extract shared credential handling"
```

---

### Task 4: CNPG grant Job

**Files:**
- Create: `src/operator/grants/postgres-job.ts`

**Interfaces:**
- Consumes: `compileGrantSql` from Task 2
- Produces: `createPostgresGrantJob(options: IGrantJobOptions): k8s.batch.v1.Job | undefined` — returns `undefined` when there is nothing to apply

- [ ] **Step 1: Implement**

Create `src/operator/grants/postgres-job.ts`:

```typescript
/**
 * Applies compiled grant SQL to a CloudNativePG database.
 *
 * The Job connects as the database owner using the owner's existing credential
 * Secret — never as superuser. The SQL is passed through a ConfigMap rather than
 * a shell argument, so nothing is interpolated into a command line.
 *
 * @module operator/grants/postgres-job
 */

import * as crypto from "node:crypto";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { compileGrantSql } from "./postgres-sql.js";
import type { IDatabaseGrant } from "../interfaces.js";

const PG_IMAGE_REPO = "ghcr.io/cloudnative-pg/postgresql";
const JOB_TTL_SECONDS = 300;
const JOB_BACKOFF_LIMIT = 5;

/** Options for {@link createPostgresGrantJob}. */
export interface IGrantJobOptions {
  readonly clusterName: string;
  readonly databaseName: string;
  /** Role receiving the grants. */
  readonly roleName: string;
  /** Database owner; the Job authenticates as this role. */
  readonly ownerName: string;
  /** Secret holding the owner's credentials. */
  readonly ownerSecretName: string;
  readonly grants: ReadonlyArray<IDatabaseGrant>;
  readonly extraSql?: ReadonlyArray<string>;
  readonly namespace: string;
  readonly endpoint: pulumi.Output<string>;
  readonly pgVersion: string;
  readonly labels: Record<string, string>;
  readonly provider: k8s.Provider;
  readonly dependsOn: pulumi.Resource[];
}

/**
 * Create a Job that applies grants and extra SQL, or nothing if neither is set.
 *
 * The Job's name embeds a checksum of the SQL, so a changed spec produces a new
 * Job and an unchanged spec does not re-run.
 *
 * @param options - Cluster, role, owner, grants, and dependencies
 * @returns The Job, or `undefined` when there is no SQL to apply
 */
export function createPostgresGrantJob(
  options: IGrantJobOptions
): k8s.batch.v1.Job | undefined {
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

  const checksum = crypto.createHash("sha256").update(sql).digest("hex").slice(0, 8);
  const baseName = `cnpg-grants-${options.clusterName}-${options.databaseName}-${options.roleName}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  const jobName = `${baseName}-${checksum}`;

  const sqlConfigMap = new k8s.core.v1.ConfigMap(
    `${jobName}-sql`,
    {
      metadata: { name: `${jobName}-sql`, namespace: options.namespace, labels: options.labels },
      data: { "grants.sql": sql },
    },
    { provider: options.provider, dependsOn: options.dependsOn }
  );

  return new k8s.batch.v1.Job(
    jobName,
    {
      metadata: { name: jobName, namespace: options.namespace, labels: options.labels },
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
                command: ["psql", "-v", "ON_ERROR_STOP=1", "-f", "/sql/grants.sql"],
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
                volumeMounts: [{ name: "sql", mountPath: "/sql" }],
              },
            ],
            volumes: [{ name: "sql", configMap: { name: `${jobName}-sql` } }],
          },
        },
      },
    },
    { provider: options.provider, dependsOn: [...options.dependsOn, sqlConfigMap] }
  );
}
```

- [ ] **Step 2: Verify and commit**

```bash
npm run format && npm run lint && npm run typecheck
git add src/operator/grants/postgres-job.ts
git commit -m "feat(operator): add PostgreSQL grant reconciliation job"
```

---

### Task 5: CNPG `addRole()`

**Files:**
- Modify: `src/operator/cnpg.ts`

**Interfaces:**
- Consumes: `resolveRoleConfig` (Task 1), `createRoleCredentials`/`replicateConnectionSecrets` (Task 3), `createPostgresGrantJob` (Task 4)
- Produces: `addRole()` on the object returned by `createSingleCnpgDatabaseInstance`

- [ ] **Step 1: Extract a shared role provisioner**

In `src/operator/cnpg.ts`, add a module-level function that creates one role. Both the owner (from `createDatabase`) and additional roles (from `addRole`) go through it:

```typescript
/**
 * Provision one PostgreSQL role: credentials Secret, basic-auth projection,
 * DatabaseRole CR, and replicated connection Secrets.
 */
function provisionCnpgRole(options: {
  readonly clusterName: string;
  readonly dbName: string;
  readonly roleName: string;
  readonly resolved: IResolvedRoleConfig;
  readonly postgresOptions: IDatabaseRoleConfig["engineOptions"] extends infer E
    ? E extends { postgresql?: infer P }
      ? P
      : never
    : never;
  readonly endpoint: pulumi.Output<string>;
  readonly port: pulumi.Output<number>;
  readonly cluster: k8s.apiextensions.CustomResource;
  readonly provider: k8s.Provider;
  readonly secretNameSuffix: string;
  readonly aliasPrefix?: string;
}): { role: k8s.apiextensions.CustomResource; secrets: Record<string, pulumi.Output<string>>; stablePassword: pulumi.Output<string> }
```

Prefer a plain named interface over the conditional type above — declare
`interface ICnpgRoleOptions { ... postgresOptions?: { inRoles?: string[]; connectionLimit?: number; validUntil?: string } ... }`
and use that. The conditional form is shown only to make the field's origin obvious.

The body reuses the code already in `createSingleCnpgDatabaseInstance` (`cnpg.ts:86-186`): `createRoleCredentials` for the Opaque user Secret, a second basic-auth Secret seeded from `stablePassword`, then the `DatabaseRole` CR with `login`, `passwordSecret`, `databaseRoleReclaimPolicy`, and — new — `inRoles`, `connectionLimit`, `validUntil` when supplied.

- [ ] **Step 2: Reimplement `createSingleCnpgDatabaseInstance` on it**

The owner role becomes `provisionCnpgRole({ roleName: username, resolved: resolveRoleConfig({ namespaces: dbConfig.namespaces, login: true }), secretNameSuffix: "user" })`. **The existing logical resource names must be preserved exactly** — `${clusterName}-${dbName}-user-secret`, `${clusterName}-${dbName}-user-secret-read`, `${clusterName}-${dbName}-role-secret`, `${clusterName}-${dbName}-role-cr`, `${clusterName}-${dbName}-database-cr`, `${clusterName}-${dbName}-secret-${targetNs}`. If the refactor changes any of them, add `aliases: [{ name: "<old-name>" }]`.

- [ ] **Step 3: Add `addRole()` to the returned object**

```typescript
    addRole(roleName: string, roleConfig?: IDatabaseRoleConfig): IDatabaseRole {
      const resolved = resolveRoleConfig(roleConfig);
      const { role, secrets: roleSecrets } = provisionCnpgRole({
        clusterName,
        dbName,
        roleName,
        resolved,
        postgresOptions: roleConfig?.engineOptions?.postgresql,
        endpoint,
        port,
        cluster,
        provider,
        secretNameSuffix: roleName,
      });

      createPostgresGrantJob({
        clusterName,
        databaseName: dbName,
        roleName,
        ownerName: username,
        ownerSecretName: userSecretName,
        grants: resolved.grants,
        namespace: DATA_NAMESPACE,
        endpoint,
        pgVersion: DEFAULT_PG_VERSION,
        labels: resourceLabels,
        provider,
        dependsOn: [database, role],
      });

      return {
        name: roleName,
        databaseName: dbName,
        clusterName,
        secrets: roleSecrets,
        nativeResource: role,
      };
    },
```

- [ ] **Step 4: Wire `sql` from `IOperatorDatabaseConfig`**

Add `readonly sql?: string[];` to `IOperatorDatabaseConfig` in `src/operator/interfaces.ts` with the TypeDoc from the spec ("Statements MUST be idempotent — the Job re-runs whenever the content checksum changes"), and in `createSingleCnpgDatabaseInstance` call `createPostgresGrantJob` once with `extraSql: dbConfig.sql ?? []`, `roleName: username`, `ownerName: username`.

- [ ] **Step 5: Verify and commit**

```bash
npm run format && npm run lint && npm run typecheck && npm run test:coverage
git add src/operator/cnpg.ts src/operator/interfaces.ts
git commit -m "feat(operator/cnpg): add addRole() and reimplement createDatabase on it"
```

---

### Task 6: MariaDB `addRole()`

**Files:**
- Modify: `src/operator/mariadb.ts`

**Interfaces:**
- Consumes: Task 1, Task 3
- Produces: `addRole()` on the MariaDB database instance

- [ ] **Step 1: Extract a shared role provisioner**

Mirror Task 5: one function creating the password Secret (via `createRoleCredentials`), the `User` CR, one `Grant` CR per entry in `resolved.grants`, and the replicated connection Secrets.

Grant mapping — `IDatabaseGrant` → `k8s.mariadb.com/v1alpha1 Grant`:

```typescript
{
  mariaDbRef: { name: clusterName },
  privileges: grant.privileges.map((p) => p.toUpperCase()),
  database: dbName,
  table: grant.objects && grant.objects !== "all" ? grant.objects : "*",
  username: roleName,
  host: mariadbOptions?.host ?? "%",
  grantOption: false,
}
```

`grant.schema` is ignored on MariaDB (no schema concept distinct from database) — document this in the TypeDoc for `IDatabaseGrant.schema`, which already says "PostgreSQL only".

- [ ] **Step 2: Reimplement `createSingleMariadbDatabaseInstance` on it**

The owner keeps `privileges: ["ALL PRIVILEGES"]`, `table: "*"`, `grantOption: true`.

**Preserve these logical names exactly**, or alias them: `${clusterName}-${dbName}-database`, `${clusterName}-${dbName}-password-secret`, `${clusterName}-${dbName}-user`, `${clusterName}-${dbName}-grant`, `${clusterName}-${dbName}-password-read`, `${clusterName}-${dbName}-secret-${targetNs}`.

Note `createRoleCredentials` names its read-back `${resourceName}-read`. The existing MariaDB read-back is `${clusterName}-${dbName}-password-read` while its Secret resource is `${clusterName}-${dbName}-password-secret` — so the derived name would be `${clusterName}-${dbName}-password-secret-read`, which is a **rename**. Add `aliases: [{ name: \`${clusterName}-${dbName}-password-read\` }]`, or pass an explicit override. This is exactly the class of rename the Global Constraints call a release blocker.

- [ ] **Step 3: Add `addRole()` returning `IDatabaseRole`**

Same shape as Task 5 Step 3, with `nativeResource` set to the `User` CR.

- [ ] **Step 4: Verify and commit**

```bash
npm run format && npm run lint && npm run typecheck && npm run test:coverage
git add src/operator/mariadb.ts
git commit -m "feat(operator/mariadb): add addRole() and reimplement createDatabase on it"
```

---

### Task 7: Neo4j `addRole()`

**Files:**
- Modify: `src/operator/neo4j.ts`

- [ ] **Step 1: Add `addRole()` and reject grants**

Extract the user-creation logic at `neo4j.ts:366-455` into a provisioner used by both `createDatabase` and `addRole`. In `addRole`, before doing anything:

```typescript
      if (resolved.grants.length > 0) {
        throw new AnyCloudError(
          `Neo4j does not support declarative grants (role "${roleName}" on "${dbName}"). ` +
            `Neo4j Community has no RBAC; remove the grants option.`,
          "UNSUPPORTED_ROLE_OPTION"
        );
      }
```

- [ ] **Step 2: Stop swallowing the GRANT ROLE failure**

`neo4j.ts:429` currently ends `|| true`, hiding the Enterprise-only failure. Replace the two-command script with a single `CREATE USER` and drop the `GRANT ROLE` line entirely — Community cannot honour it, and the spec's rule is that a silently-ignored option must not ship.

```typescript
                    command: [
                      "sh",
                      "-c",
                      `cypher-shell -a "bolt://$NEO4J_HOST:${NEO4J_BOLT_PORT}" -u neo4j -p "$NEO4J_ADMIN_PASSWORD" "CREATE USER \\\`$DB_USER\\\` IF NOT EXISTS SET PLAINTEXT PASSWORD '$DB_PASSWORD' SET PASSWORD CHANGE NOT REQUIRED"`,
                    ],
```

- [ ] **Step 3: Make `addRole()` required**

If Task 1 shipped `addRole?()` as optional, remove the `?` in `src/operator/interfaces.ts` now that all three backends implement it.

- [ ] **Step 4: Verify and commit**

```bash
npm run format && npm run lint && npm run typecheck && npm run test:coverage
git add src/operator/neo4j.ts src/operator/interfaces.ts
git commit -m "feat(operator/neo4j): add addRole() and stop swallowing GRANT ROLE failures"
```

---

### Task 8: `migrate` CLI command

**Files:**
- Create: `src/cli/migrate.ts`
- Modify: `src/cli.ts:197-205`

- [ ] **Step 1: Implement the read-only pre-flight**

Create `src/cli/migrate.ts` exporting `runMigrateChecks(version: string): number` (returns a process exit code). It must not mutate anything. Checks:

1. `kubectl get crd databases.postgresql.cnpg.io databaseroles.postgresql.cnpg.io` — CNPG 1.30+ present.
2. Role attributes: run the `pg_roles` query from `docs/cnpg-declarative-databases.md` and flag any role whose attributes differ from `login=t, super=f, createdb=f, createrole=f, inherit=t, connlimit=-1, bypassrls=f, memberof={}`.
3. Database ownership matches.
4. `grep -rn "-superuser"` across the working directory, excluding `node_modules` and `dist`.

Print a section per check with PASS/WARN/FAIL, and return `1` if any FAIL.

- [ ] **Step 2: Wire the command**

In `src/cli.ts`, add to the switch and to the usage banner at the top of the file:

```typescript
    case "migrate":
      process.exit(runMigrateChecks(args[1] ?? "v3"));
      break;
```

- [ ] **Step 3: Verify and commit**

```bash
npm run format && npm run lint && npm run typecheck
git add src/cli.ts src/cli/migrate.ts
git commit -m "feat(cli): add read-only migrate pre-flight command"
```

---

### Task 9: Documentation

**Files:**
- Create: `docs/migrations/v3.md`
- Modify: `README.md:144-147`
- Modify: `docs/api-reference.md`

- [ ] **Step 1: Write the migration guide**

`docs/migrations/v3.md` covers: the compatibility table from the spec; that `npm install` + `pulumi up` is the whole upgrade; `npx @reyemtech/nimbus migrate v3` as the pre-flight; the `superuserAccess` behavioural change and how to opt out; the alias guarantee and how to verify it (`pulumi preview` showing zero `replace`); and the `ALTER ROLE … SET` limitation from Known Limitations.

- [ ] **Step 2: Add `addRole()` to the API reference**

Document `addRole()`, `IDatabaseGrant`, `IDatabaseRoleConfig`, `IDatabaseRole`, and the `sql` option, with the three per-engine usage examples.

- [ ] **Step 3: Link both from the README docs list.**

- [ ] **Step 4: Commit**

```bash
git add docs/migrations/v3.md docs/api-reference.md README.md
git commit -m "docs: add v3 migration guide and addRole API reference"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
| --- | --- |
| `IDatabaseRoleConfig` / `IDatabaseGrant` / `IDatabaseRole` | 1 |
| `addRole()` on `IDatabaseInstance` | 1 (declare), 5–7 (implement), 7 (make required) |
| `IOperatorDatabaseConfig.sql` | 5 |
| `objects: "all"` portable semantics | 2 (PostgreSQL), 6 (MariaDB) |
| CNPG grant reconciliation, owner not superuser | 2, 4 |
| Neo4j throws on grants; fix swallowed failure | 7 |
| `createDatabase()` collapses onto `addRole()` | 5, 6, 7 |
| Pulumi aliases | Global Constraints + explicitly called out in 5 and 6 |
| `migrate v3` read-only pre-flight | 8 |
| Unit tests for compiler and config | 1, 2 |
| Migration docs | 9 |

**Gap found and closed:** the spec's Testing section named `grant-diff.test.ts`. There is no diff — the revoke-then-grant design replaces it — so those cases are folded into `postgres-sql.test.ts` ("revokes existing privileges before granting", "defaults objects to all", removal-by-omission).

**Type consistency:** `IResolvedRoleConfig` is produced in Task 1 and consumed in 5–7. `compileGrantSql`/`quoteIdentifier`/`normalizePrivilege` are produced in Task 2 and consumed in Task 4. `createRoleCredentials`/`replicateConnectionSecrets` are produced in Task 3 and consumed in 5–7. `createPostgresGrantJob` is produced in Task 4 and consumed in Task 5. Names match across all references.

**Known plan risk:** Task 1 Step 1 contains a self-correction (the coverage-exclude glob forces `role-config.ts` under `grants/`). The corrected path `src/operator/grants/role-config.ts` is used consistently from that point on.
