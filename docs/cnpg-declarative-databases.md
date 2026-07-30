# Migration: CNPG databases from bootstrap Jobs to declarative CRDs

`createDatabase()` on a CloudNativePG cluster used to run a one-shot `psql` Job that
issued `CREATE ROLE` / `CREATE DATABASE` / `GRANT`. It now creates two CloudNativePG
custom resources instead:

| Before                                   | After                                       |
| ---------------------------------------- | ------------------------------------------- |
| `batch/v1` Job running `psql`             | `postgresql.cnpg.io/v1` `DatabaseRole`      |
| `enableSuperuserAccess: true` (mandatory) | `postgresql.cnpg.io/v1` `Database`          |
| runs once, never reconciles               | reconciled continuously by the operator     |
| no deletion path                          | `reclaimPolicy` controls end-of-life        |

## Why

The Job approach forced `enableSuperuserAccess: true` on every cluster purely so the Job
could authenticate as `postgres` over the network. It also built SQL by shell-string
interpolation, ran exactly once (so drift — a dropped role, a changed owner — was never
corrected), and had no way to remove a database that had been dropped from config.

The `Database` and `DatabaseRole` CRDs are reconciled by the operator's instance manager,
which connects locally and does not need a network-reachable superuser.

## Requirements

CloudNativePG **1.30 or newer** on the target cluster. Verify:

```bash
kubectl get crd databases.postgresql.cnpg.io databaseroles.postgresql.cnpg.io
```

## New configuration

```typescript
const db = cluster.createCluster("pgsql-main", {
  // Default is now false. Set true only if something outside nimbus connects as `postgres`.
  superuserAccess: false,
});

db.createDatabase("n8n", {
  namespaces: ["apps"],
  // "retain" (default) — dropping this call leaves the database in PostgreSQL.
  // "delete" — the operator issues DROP DATABASE / DROP ROLE when the CR is removed.
  reclaimPolicy: "retain",
});
```

`createDatabase()` creates the database and its owner role only. Additional roles —
with their own grants, reconciled by a `psql` Job running as the owner rather than
superuser — are provisioned afterward via `db.addRole(name, config)`, and one-off
setup a CRD cannot express (`CREATE EXTENSION`, seeding a schema) via
`config.sql`. Both are documented in full, with worked examples for every engine,
in [the API reference](./api-reference.md#dbaddrolename-config) and
[the v3 migration guide](./migrations/v3.md).

## Migrating an existing cluster

Adoption is non-destructive. The operator's `Database` reconciler calls `detectDatabase`
first and, when the database already exists, takes the `updateDatabase` path — it only
issues `ALTER` statements for fields the manifest sets explicitly, plus
`ALTER DATABASE … OWNER TO`, which already matches the owner nimbus assigned. `DatabaseRole`
adopts an existing role the same way. No database is dropped or recreated.

### 1. Confirm adoption will be a no-op

`DatabaseRole` adoption forces attributes **omitted** from the manifest back to their
defaults, so check that every role nimbus manages still carries only what the bootstrap Job
gave it. Roles created by the Job have `LOGIN` plus a password and nothing else, which is
exactly what the new manifest declares:

```bash
kubectl exec -n data <cluster>-1 -- psql -tAc "
  SELECT r.rolname, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole,
         r.rolinherit, r.rolconnlimit, r.rolbypassrls,
         coalesce(array_agg(m.rolname) FILTER (WHERE m.rolname IS NOT NULL), '{}') AS memberof
  FROM pg_roles r
  LEFT JOIN pg_auth_members am ON am.member = r.oid
  LEFT JOIN pg_roles m ON m.oid = am.roleid
  WHERE r.rolname NOT LIKE 'pg\_%'
  GROUP BY 1,2,3,4,5,6,7,8 ORDER BY 1"
```

For each role nimbus manages, expect `t|f|f|f|t|-1|f|{}` — login true, `inherit` true,
`connlimit` -1, everything else false, no role memberships. Any role that deviates (a
hand-granted `CREATEDB`, `SUPERUSER`, or membership in another role) **will lose that
attribute on adoption**; either add it back after migrating or leave that database out.

Then confirm database ownership already matches what nimbus assigns, so the
`ALTER DATABASE … OWNER TO` on adoption is a no-op:

```bash
kubectl exec -n data <cluster>-1 -- psql -tAc "
  SELECT d.datname, pg_get_userbyid(d.datdba)
  FROM pg_database d WHERE NOT d.datistemplate ORDER BY 1"
```

Databases in the cluster that nimbus does **not** manage are unaffected — no CR is created
for them.

### 2. Decide on superuser access before applying

`superuserAccess` now defaults to `false`. On an existing cluster this flips
`enableSuperuserAccess` to false, which makes CNPG **set the `postgres` password to NULL
and delete the `{cluster}-superuser` Secret**. Nothing in nimbus reads that Secret once the
Jobs are gone, but check for out-of-band consumers first:

```bash
kubectl get secret -n data <cluster>-superuser -o yaml   # confirm what exists today
grep -rn '<cluster>-superuser' .                          # anything referencing it?
```

If something does need it, set `superuserAccess: true` explicitly and migrate off it later.

### 3. Preview

```bash
pulumi preview --diff
```

Expect, per database:

- **delete** `kubernetes:batch/v1:Job` `cnpg-init-db-*` — these already self-deleted from
  the cluster via `ttlSecondsAfterFinished: 300`, so this only prunes Pulumi state.
- **create** `Secret` `{cluster}-{db}-role` — a `kubernetes.io/basic-auth` projection of the
  existing credentials. It is a separate object because `Secret.type` is immutable:
  converting the existing `{cluster}-{db}-user` Secret in place would force a replace and
  regenerate the password, breaking running applications.
- **create** `DatabaseRole` and `Database` CRs.

And once per cluster, if you accepted the new default:

- **update** `Cluster` with `enableSuperuserAccess: false`.

Nothing should show as a **replace** on `{cluster}-{db}-user` or on the per-namespace
connection Secrets. If it does, stop — the password would rotate.

### 4. Apply and verify

```bash
pulumi up

kubectl get databases.postgresql.cnpg.io,databaseroles.postgresql.cnpg.io -n data
```

Both should report `APPLIED: true` with an empty message. Then confirm the application
credentials still work — the role password is re-applied from the basic-auth Secret, which
was seeded from the existing stored password, so it should be unchanged:

```bash
kubectl exec -n data <cluster>-1 -- psql -c '\l'
kubectl exec -n data <cluster>-1 -- psql -c '\du'
```

## Rollback

`reclaimPolicy` defaults to `retain`, so deleting the CRs leaves every database and role
intact in PostgreSQL. To revert, remove the CRs and set `superuserAccess: true`; the data is
untouched and the previous Job-based flow can be restored from git history.

## Caveats

- **Do not point a nimbus-managed `Database` CR at a database that already has a
  hand-applied `Database` CR.** Two CRs naming the same `spec.name` on the same cluster will
  fight over ownership. Clusters managed outside nimbus with their own manifests (the
  `corp-data-layer` pattern of applying `shared/k8s/*.yaml` directly) should stay outside
  `createDatabase()`.
- If a role is also listed in the Cluster's `spec.managed.roles`, the inline entry wins and
  the `DatabaseRole` reports a conflict in its status without reconciling. nimbus does not
  set `managed.roles`, so this only applies to hand-edited clusters.
- `DatabaseRole` adoption forces attributes **omitted** from the manifest back to their
  defaults. nimbus sets `login: true` explicitly; every other attribute already matches the
  PostgreSQL default that the bootstrap Job left in place. A role you hand-granted
  `CREATEDB` or `SUPERUSER` to would lose it.
- **One owner per database.** Two `createDatabase()` calls sharing the same `owner` would
  produce two `DatabaseRole` CRs managing the same PostgreSQL role with different passwords,
  and they would overwrite each other on every reconcile. The old Job was one-shot so it
  merely settled on whichever ran last; the CRs will fight indefinitely. Give each database
  its own owner, and create secondary roles out-of-band.
- This change is CloudNativePG-only. The MariaDB backend already used the operator's
  `Database`/`User`/`Grant` CRDs; Neo4j still provisions users through a `cypher-shell` Job.
