# API reference

Nimbus exports provider-agnostic factories from `@reyemtech/nimbus`, plus provider-specific factories through `@reyemtech/nimbus/aws` and `@reyemtech/nimbus/azure`.

## High-level factories

| Factory                                    | Purpose                                                                                                    |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `createNetwork(name, config)`              | Create or attach provider networking.                                                                      |
| `createCluster(name, config, network?)`    | Create EKS, AKS, or Rackspace Spot cluster; multi-cloud targets return one cluster per provider.           |
| `createDns(name, config)`                  | Create DNS zones and records.                                                                              |
| `createSecrets(name, config)`              | Create a provider-backed secrets store.                                                                    |
| `createPlatformStack(name, config)`        | Install cluster platform services, including ingress, DNS automation, cert-manager, and optional Headlamp. |
| `createObservabilityStack(name, config)`   | Install monitoring, logging, dashboards, and alerting.                                                     |
| `createAccessGateway(name, config)`        | Install a Tailscale or WireGuard access gateway.                                                           |
| `createServiceAccountAccess(name, config)` | Create scoped Kubernetes ServiceAccount access and a secret portable kubeconfig.                           |
| `createOperator(type, config)`             | Install a database operator.                                                                               |
| `createArgoCD(name, config)`               | Configure Argo CD on an existing cluster.                                                                  |
| `createGlobalLoadBalancer(name, config)`   | Configure global traffic distribution.                                                                     |
| `createStateBackend(name, config)`         | Configure cloud object storage and locking for Pulumi state.                                               |

See provider guides for cloud-specific options: [AWS](providers/aws.md), [Azure](providers/azure.md), and [Rackspace](providers/rackspace.md).

## Cluster results and fluent conveniences

Nimbus cluster factories return `IClusterWithFluentOperations`, which extends the structurally compatible `ICluster` contract with convenience wrappers for high-level cluster factories:

```typescript
const access = cluster.createServiceAccountAccess("ci", {
  scope: { type: "namespace", namespace: "apps", role: "view" },
});

const platform = cluster.createPlatformStack("platform", { domain: "example.test" });
```

The available methods are `createServiceAccountAccess`, `createAccessGateway`, `createPlatformStack`, `createObservabilityStack`, `createOperator`, and `createArgoCD`. Each delegates to its standalone factory. Resource-level helpers remain composable without a cluster fluent method. Caller-created `ICluster` objects do not need to implement the fluent methods.

## Platform and cluster services

`createPlatformStack` can install core ingress, cert-manager, and DNS automation, with optional components such as Headlamp. Headlamp is installed as a private ClusterIP service by default. By default, its managed pod ServiceAccount authenticates dashboard requests and is bound to the read-only `view` ClusterRole, so no separate login token is needed. All viewers share that identity and permission set; expose it only through a trusted authentication proxy or private network such as a restricted tailnet. Set `headlamp.authentication: "user-token"` to require each viewer to provide their own Kubernetes token. `createAccessGateway` supports Tailscale and WireGuard. `createObservabilityStack` is separate from the cluster-scoped EKS Metrics Server add-on.

For AWS EKS Route 53 split DNS, `externalDns.route53.privateHostedZones` opts into a public ExternalDNS controller for Ingress/Service/Traefik records and a private controller for private Ingresses. A created zone accepts an optional one-label `prefix` and defaults to `internal.<domain>`; use distinct prefixes such as `cac-1` for clusters sharing a parent domain. Ingresses select visibility with `nimbus.dev/dns-visibility: public|private`; missing annotations remain public. Existing private zones require an explicit zone ID and domain filter. Split mode defaults to `upsert-only` to preserve old records during public-to-private migration. See [AWS private DNS and Ingress visibility](providers/aws.md#private-route-53-zones-and-ingress-dns-visibility) for the complete API, ownership, Tailnet, and migration behavior.

## ServiceAccount access

`createServiceAccountAccess(name, config)` accepts an `IServiceAccountAccessConfig` with a cluster, a typed `scope`, and optional ServiceAccount namespace and API endpoint override. Scopes support cluster `cluster-admin`/`view`, namespace `admin`/`edit`/`view`, and custom Role or ClusterRole references. The returned `IServiceAccountAccess` includes the ServiceAccount, token Secret, RBAC binding, and secret `kubeconfig` output.

See [Kubernetes access](guides/kubernetes-access.md) for RBAC semantics, token lifecycle, export commands, and examples.

## Shared cloud target model

Factories accept provider shorthand (`"aws"`), an explicit target (`{ provider: "aws", region: "ca-central-1" }`), or a multi-provider target array (`["aws", "azure"]`) where supported. Region defaults are defined by `DEFAULT_REGIONS`. Provider-specific requirements remain explicit; for example, Azure cluster and resource creation requires an Azure resource group.

## Escape hatches

Cluster, network, DNS, and other provider-backed result types expose their native Pulumi resource through `nativeResource`. Cluster results also expose their Kubernetes provider for direct Kubernetes resources.

## Database operators

### `createOperator(type, config)`

Deploys a Kubernetes database operator via Helm — CloudNativePG, MariaDB Operator,
Neo4j (single-instance, no separate operator release), or MinIO. Returns
`IOperator` (the first three) or `IMinIOOperator` (MinIO's `createBucket()` API
differs and is out of scope here).

```typescript
import { createOperator } from "@reyemtech/nimbus";
import type { ICluster, IOperator } from "@reyemtech/nimbus";

const operator = createOperator("cloudnative-pg", { cluster });
const pg = operator.createCluster("pgsql-main", { replicas: 2, storageGb: 20 });
```

`IOperator.createCluster(name, config?)` returns `IClusterInstance`, whose
`createDatabase(name, config)` provisions a database and its owner and returns
`IDatabaseInstance`. See `docs/migrations/v3.md` for the full migration story if
you're upgrading from a version where `createDatabase()` did not use these CRDs.

### `db.addRole(name, config?)`

Every `IDatabaseInstance` — regardless of engine — implements `addRole()`:
creates an additional login role/user on the database, generates its password,
and replicates a connection Secret into the given namespaces. The API is uniform
across engines; the mechanism and the guarantees behind it are not:

| Engine            | Mechanism                                                                                                                                                                                                                                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CloudNativePG     | `DatabaseRole` CR for the role itself. Grants have no CRD, so they are applied by a `psql` Job that authenticates as the **database owner**, never superuser — one transaction that revokes every privilege the role currently holds and re-grants the requested set, so removing a grant from config actually revokes it. |
| MariaDB           | `User` CR for the account, one `Grant` CR per requested grant. Fully declarative — no SQL, no Job.                                                                                                                                                                                                                         |
| Neo4j (Community) | a one-shot `cypher-shell` Job running `CREATE OR REPLACE USER`. There is no RBAC to reconcile — any `grants` value throws, `[]` included.                                                                                                                                                                                  |

```typescript
interface IDatabaseRoleConfig {
  namespaces?: string[]; // Secret replication targets. Default: none.
  login?: boolean; // Default: true. false throws on MariaDB and Neo4j.
  grants?: IDatabaseGrant[]; // Omitted = unmanaged; [] = hold nothing. Throws on Neo4j.
  reclaimPolicy?: "retain" | "delete"; // CloudNativePG only; ignored elsewhere. Default: "retain".
  // A block for an engine other than the one running the role throws.
  engineOptions?: {
    postgresql?: { inRoles?: string[]; connectionLimit?: number; validUntil?: string };
    mariadb?: { host?: string; maxUserConnections?: number };
  };
}

interface IDatabaseGrant {
  privileges: string[]; // e.g. ["SELECT"], ["SELECT", "INSERT"]
  schema?: string; // PostgreSQL only. Default: "public". Dropped on MariaDB (no schema concept).
  objects?: string; // A table/object name, or "all" for current + future objects. Default: "all".
}

interface IDatabaseRole {
  name: string;
  databaseName: string;
  clusterName: string;
  secrets: Record<string, pulumi.Output<string>>; // namespace → Secret name
  nativeResource: pulumi.Resource;
}
```

`addRole()` throws an `AnyCloudError` with code `UNSUPPORTED_ROLE_OPTION` when:

- `name` equals the database's owner — the owner's role already exists (created by
  `createDatabase()`); a second CR/Job for the same account would fight the first
  over its password.
- `name` is already claimed by another role **anywhere on the same cluster** — see
  "Role names are unique per cluster" below.
- `grants` is passed on Neo4j — including `grants: []`. Community edition has no
  RBAC, so neither a privilege set nor "this role holds no privileges" can be
  honoured: every Neo4j account can read and write the whole graph.
- `login: false` is passed on MariaDB or Neo4j (every account there is a login
  account).
- an `engineOptions` block for a **different** engine is present: `mariadb` on
  CloudNativePG, `postgresql` on MariaDB, or either one on Neo4j (which reads
  neither). The block would otherwise provision successfully with the host,
  connection cap, memberships or expiry it asks for simply absent. Presence is
  what is rejected, so an empty `{}` block throws too.
- `name` contains a backtick, single quote, double quote, backslash, or NUL byte,
  on any engine.
- `name` is empty or holds nothing but whitespace, on any engine. No engine can
  create an account without a name, and nothing readable narrows out of one, so
  it is refused up front rather than registering a CR, a Secret and a Job that
  fail inside the controller after the deploy has reported success. The database
  name passed to `createDatabase()` is refused on the same terms.

Each replicated Secret carries `host`, `port`, `username`, `password`, `database`
and `uri` (Neo4j adds `httpPort` and the `NEO4J_*` driver aliases). **Only `uri`
is percent-encoded** — a role named `reporting@corp` appears in it as
`reporting%40corp`, because `@` is a URI delimiter and interpolating it raw would
make a parser read the wrong user, password and host. Every other key holds the
raw value, since clients consume those literally. See
[Secrets](secrets.md#standardized-keys).

The Kubernetes objects a role creates are named `{cluster}-{database}-role-{role}`,
with the role segment narrowed into the DNS-1123 character set. That narrowing is
lossy — `Read_Only` and `read_only` are two distinct roles that both narrow to
`read-only` — so **every role segment carries a short hash of the raw name**:
`reader` becomes `reader-3d094196` and `Read_Only` becomes `read-only-7b1060cf`.
The hash is unconditional rather than reserved for names the narrowing changed,
because a role could otherwise be named after another role's encoded form
(`read-only-7b1060cf` is itself a legal role name) and the two would collide on
one Pulumi logical name. The raw name is what reaches the database and the Secret
payload either way.

#### Role names are unique per cluster, not per database

`addRole()` is called on a database, but a **login identity is not a database
object** — on all three engines it lives at the cluster/instance/deployment level
and serves every database on it. So the role name you pass must be unique across
the whole cluster, not just the database:

```typescript
const pg = operator.createCluster("pgsql-main");
const billing = pg.createDatabase("billing", { namespaces: ["app"] });
const analytics = pg.createDatabase("analytics", { namespaces: ["app"] });

billing.addRole("reader", { grants: [{ privileges: ["SELECT"] }] });
analytics.addRole("reader", { grants: [{ privileges: ["SELECT"] }] }); // throws
```

Both calls describe the one cluster-global role `reader`, each pointing it at a
different generated password Secret. Their Pulumi logical names are derived from
the database name and therefore differ, so `pulumi preview` reports no conflict —
in production the two `DatabaseRole` controllers would then rewrite that role's
password against each other on every reconcile, until at least one database's
replicated connection Secrets stopped authenticating. nimbus rejects the second
claim at build time instead, with code `UNSUPPORTED_ROLE_OPTION`.

The registry covers every role on the cluster, so a database's **owner** counts
too: `analytics.addRole("billing")` fails because `billing`'s owner already holds
that name. Give the roles distinct names (`billing-reader`, `analytics-reader`) —
nimbus deliberately does not rename them for you, because the role you would get
back would not be the one you asked for. If you genuinely want _one_ role reading
from both databases, call `addRole()` once and grant it on the second database
through that database's `sql` escape hatch — nimbus models a role's privileges
only in the database it was added to.

**MariaDB is the same rule keyed on `user`@`host`**, because that pair is what
MariaDB treats as one account. `reader`@`%` claimed by one database blocks
`reader`@`%` on another, but `reader`@`10.0.0.1` and `reader`@`10.0.0.2` are two
genuinely distinct accounts and are both allowed. The host comes from
`engineOptions.mariadb.host` and defaults to `%`; a database's owner counts as
holding `<database>`@`%`, since its `User` CR omits `spec.host` and takes the
operator's default.

**Neo4j enforces the rule per deployment**, keyed on the username alone — there
is no host component. Its failure mode is as quiet as the other two and less
stable: both roles' provisioning Jobs set the one shared account's password to
their own generated value, so whichever runs last wins and the other role's
replicated connection Secrets are left holding a password the account no longer
has. Neither Job reports a failure.

The check is scoped to one `createCluster()` call in one Pulumi program, which is
the whole picture whenever a physical cluster is owned by a single stack. If two
separate stacks provision roles on the _same_ live cluster, nothing at build time
can see across them — that is a deployment topology to avoid, not a case this
guard covers.

It throws code `INVALID_GRANT` when a grant lists zero privileges, and code
`UNSUPPORTED_PRIVILEGE` when a grant names a privilege the engine's grant path
cannot emit. On CloudNativePG the allowed set is `SELECT`, `INSERT`, `UPDATE`,
`DELETE`, `TRUNCATE`, `REFERENCES`, `TRIGGER`, `ALL PRIVILEGES` — every one of
them is valid in the `GRANT ... ON ALL TABLES IN SCHEMA ...` / `GRANT ... ON

<table>` statements the compiler emits. `USAGE` and `CREATE` are **not** accepted:
they are schema privileges, not relation privileges, so they would render as
`GRANT USAGE ON ALL TABLES IN SCHEMA ...` and fail at runtime. Nothing is lost —
`GRANT USAGE ON SCHEMA` is emitted automatically for every grant.

MariaDB validates against its own set, not PostgreSQL's: `ALL PRIVILEGES`,
`ALTER`, `ALTER ROUTINE`, `CREATE`, `CREATE ROUTINE`, `CREATE TEMPORARY TABLES`,
`CREATE VIEW`, `DELETE`, `DELETE HISTORY`, `DROP`, `EVENT`, `EXECUTE`, `INDEX`,
`INSERT`, `LOCK TABLES`, `REFERENCES`, `SELECT`, `SHOW VIEW`, `TRIGGER`,
`UPDATE` — everything a database- or table-scoped `GRANT` can carry. `TRUNCATE`
does not exist there, and global privileges such as `SUPER` or `PROCESS` cannot
be scoped to a database. `GRANT OPTION` is not a privilege here either: the
`Grant` CR models it as its own field, which nimbus sets only for the owner.

**Omitting `grants` is not the same as `grants: []`.** Omitting it means nimbus
does not manage the role's privileges: nothing is granted and, on CloudNativePG,
nothing is revoked. `grants: []` means the role should hold _no_ privileges — a
real desired state, so the reconciling Job still runs and revokes everything.
That is what makes removing the last grant from a config take access away
instead of freezing it. On MariaDB the two coincide (privileges live in `Grant`
CRs, which are deleted — and revoked — when they leave the config).

**MariaDB merges grants by table.** A `Grant` CR is named for the table it
covers, so two entries targeting the same table — separate `SELECT` and `INSERT`
grants on `orders`, say — become one CR whose `privileges` is the union of both.
The result is canonical: privileges are deduplicated and sorted, and grants are
ordered by table, so reordering the `grants` array produces identical CRs and no
Pulumi diff. `ALL PRIVILEGES` absorbs anything merged with it, since MariaDB's
`GRANT` grammar refuses it alongside other privileges.

`objects: "all"` is the portable "current and future objects" form. On PostgreSQL
it emits both `GRANT ... ON ALL TABLES IN SCHEMA ...` and
`ALTER DEFAULT PRIVILEGES FOR ROLE <owner> ...`, so tables created after the grant
runs are covered too. On MariaDB it becomes `table: "*"`, which already covers
later tables without a separate default-privileges concept.

**Sequences (PostgreSQL).** A grant that includes `INSERT`, `UPDATE`, or
`ALL PRIVILEGES` also grants `USAGE, SELECT` on every current and future
sequence in the grant's schema. Inserting into a `serial`/`identity` column
calls `nextval()` on a separate object with its own ACL, so without this every
such `INSERT` fails with `permission denied for sequence`. The sequence grant is
schema-wide even when `objects` names one table — a sequence's link to its table
lives in the catalog and the compiler emits static SQL. Sequence `UPDATE`
(`setval()`) is never granted, and correspondingly never revoked: the grant
Job's revoke-then-grant preamble is scoped to exactly the privileges a grant spec
can ask back, so reconciliation can never strip access that no configuration
restores. Read-only grants get no sequence privileges.

**Out-of-band grants (PostgreSQL).** The scoping above cuts both ways. If a DBA
runs `GRANT CREATE ON SCHEMA marts TO reader;` or `GRANT UPDATE ON marts.orders_id_seq
TO reader;` by hand outside of nimbus, that grant survives every future
reconciliation — the revoke preamble never issues `REVOKE ... ON SCHEMA` for
anything but `USAGE`, nor `REVOKE ... ON SEQUENCE` for anything but `USAGE,
SELECT`, so it has nothing to strip either privilege with. A hand-run table
grant does not get the same protection: `REVOKE ALL ON ALL TABLES IN SCHEMA
... FROM <role>` runs unconditionally in the preamble regardless of what put
the privilege there, so `GRANT INSERT ON marts.orders TO reader;` run by hand
is revoked on the next `addRole()` reconcile even though no `IDatabaseGrant` in
the role's config ever asked for it. In short: schema `CREATE` and sequence
`UPDATE` are privileges nimbus cannot manage in either direction, not merely
privileges it declines to grant — anything else, table grants included, is
fair game for the next revoke pass.

#### CloudNativePG example

```typescript
const pg = operator.createCluster("pgsql-main", { replicas: 2, storageGb: 20 });
const db = pg.createDatabase("warehouse", { namespaces: ["etl"] });

// Read-only role, scoped to the "marts" schema, current and future tables.
db.addRole("reporting", {
  namespaces: ["bi"],
  grants: [{ privileges: ["SELECT"], schema: "marts", objects: "all" }],
  engineOptions: { postgresql: { connectionLimit: 20 } },
});
```

#### MariaDB example

```typescript
const maria = operator.createCluster("mariadb-main", { replicas: 3, storageGb: 20 });
const db = maria.createDatabase("kimai", { namespaces: ["timetracking"] });

// Read-only role over the whole database — no schema field, MariaDB has none.
db.addRole("kimai-readonly", {
  namespaces: ["reporting"],
  grants: [{ privileges: ["SELECT"], objects: "all" }],
  engineOptions: { mariadb: { maxUserConnections: 20 } },
});
```

#### Neo4j example

```typescript
const graph = operator.createCluster("graph-main", { storageGb: 50 });
const db = graph.createDatabase("catalog", { namespaces: ["search"] });

// grants would throw UNSUPPORTED_ROLE_OPTION — Community edition has no RBAC.
// A role added here is a plain login account, nothing more.
db.addRole("catalog-etl", { namespaces: ["ingest"] });
```

### `IOperatorDatabaseConfig.sql`

Raw SQL statements applied to a CloudNativePG database as its owner, after the
database and owner role exist. Intended for one-off setup a CRD cannot express:

```typescript
pg.createDatabase("warehouse", {
  namespaces: ["etl"],
  sql: ["CREATE EXTENSION IF NOT EXISTS pgcrypto;"],
});
```

**CloudNativePG only — MariaDB and Neo4j throw.** The statements ride along in
the same owner-authenticated `psql` Job that reconciles grants. MariaDB
provisions through CRs and runs no SQL at all, and Neo4j's provisioning Job
speaks Cypher, so neither has anywhere to run them. Setting `sql` on either
throws `UNSUPPORTED_ROLE_OPTION` at preview rather than dropping the statements
silently.

Statements must be idempotent (the underlying Job re-runs whenever the SQL's
checksum changes, and may run again against a database that already has the
result of a previous run) and transaction-safe (they run inside the same
transaction as the rest of the applying script, so `CREATE INDEX CONCURRENTLY`,
`VACUUM`, and a stray `COMMIT;` will all error or truncate the script early).

## Additional guides

- [Examples](examples.md)
- [AWS/EKS details](providers/aws.md)
- [Azure/AKS details](providers/azure.md)
- [Rackspace modes and state ownership](providers/rackspace.md)
- [Documentation index](README.md)
