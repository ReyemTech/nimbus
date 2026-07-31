# API Reference

Full reference for all nimbus factory functions, provider options, and escape hatches.

## Factory Functions (Primary API)

The factory functions are the recommended way to use this library. They dispatch to the correct cloud-specific implementation based on the `cloud` parameter. Provider-specific options are passed via `providerOptions`.

All factory functions are **async** and use dynamic imports internally — the provider SDK is only loaded when the function is called with that cloud target.

### `createNetwork(name, config)`

Creates a VPC (AWS) or VNet (Azure) with subnets and NAT.

| Parameter                | Type               | Description                                               |
| ------------------------ | ------------------ | --------------------------------------------------------- |
| `name`                   | `string`           | Resource name prefix                                      |
| `config.cloud`           | `CloudArg`         | `"aws"`, `"azure"`, or `["aws", "azure"]` for multi-cloud |
| `config.cidr`            | `string`           | CIDR block (auto-offset for multi-cloud)                  |
| `config.natStrategy`     | `NatStrategy`      | `"managed"`, `"fck-nat"`, or `"none"`                     |
| `config.providerOptions` | `IProviderOptions` | Provider-specific options (see below)                     |

Returns: `Promise<INetwork>` (single cloud) or `Promise<INetwork[]>` (multi-cloud)

### `createCluster(name, config, networks)`

Creates an EKS (AWS) or AKS (Azure) cluster.

| Parameter                | Type                     | Description                                           |
| ------------------------ | ------------------------ | ----------------------------------------------------- |
| `config.nodePools`       | `INodePool[]`            | Node pool definitions                                 |
| `config.version`         | `string`                 | Kubernetes version                                    |
| `config.providerOptions` | `IProviderOptions`       | Provider-specific options                             |
| `networks`               | `INetwork \| INetwork[]` | Network(s) — auto-matched by provider for multi-cloud |

Returns: `Promise<ICluster>` (single cloud) or `Promise<ICluster[]>` (multi-cloud)

### `createDns(name, config)`

Creates a Route 53 (AWS) or Azure DNS zone.

Returns: `Promise<IDns>` (single cloud) or `Promise<IDns[]>` (multi-cloud)

### `createSecrets(name, config)`

Creates an AWS Secrets Manager or Azure Key Vault store.

```typescript
const secrets = (await createSecrets("prod", { cloud: "aws" })) as ISecrets;
secrets.putSecret("database", { host: "db.example.com", password: dbPassword });
const pw = secrets.getSecretRef({ path: "database", key: "password" });
```

Returns: `Promise<ISecrets>` (single cloud) or `Promise<ISecrets[]>` (multi-cloud)

### `createStateBackend(name, config)`

Creates an S3 bucket (AWS) or Azure Storage Account for Pulumi state with BCDR features.

| Parameter            | Type                 | Description                                              |
| -------------------- | -------------------- | -------------------------------------------------------- |
| `config.versioning`  | `boolean`            | Enable bucket/container versioning. Default: `true`      |
| `config.encryption`  | `boolean`            | Enable server-side encryption. Default: `true`           |
| `config.locking`     | `IStateLockConfig`   | State locking config (DynamoDB on AWS). Default: enabled |
| `config.replication` | `IReplicationConfig` | Cross-region replication. Default: disabled              |

Returns: `Promise<IStateBackend>` (single cloud) or `Promise<IStateBackend[]>` (multi-cloud)

**AWS features:** S3 BucketV2, public access block, versioning, SSE (AES256 or KMS), DynamoDB locking, cross-region replication with IAM.

**Azure features:** StorageAccount (StorageV2, HTTPS-only, TLS 1.2), BlobContainer, versioning, GRS for geo-replication. Azure blob leases handle locking natively.

### `createPlatformStack(name, config)`

Deploys Helm-based platform components to one or more clusters.

| Component        | Default       | Chart                                       |
| ---------------- | ------------- | ------------------------------------------- |
| Traefik          | Enabled       | `traefik/traefik` v34.3.0                   |
| cert-manager     | Enabled       | `jetstack/cert-manager` v1.17.2             |
| External DNS     | If configured | `kubernetes-sigs/external-dns` v1.16.1      |
| ArgoCD           | Disabled      | `argoproj/argo-cd` v7.8.26                  |
| Vault            | Disabled      | `hashicorp/vault` v0.29.1                   |
| External Secrets | Disabled      | `external-secrets/external-secrets` v0.14.4 |

### `createGlobalLoadBalancer(name, config)`

Routes traffic across clusters using DNS-based health checks.

| Strategy         | Behavior                                                 |
| ---------------- | -------------------------------------------------------- |
| `active-active`  | Weighted routing — equal traffic to all healthy clusters |
| `active-passive` | Failover — primary cluster, secondary on failure         |
| `geo`            | Geolocation — route by client continent                  |

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

| Engine | Mechanism |
| --- | --- |
| CloudNativePG | `DatabaseRole` CR for the role itself. Grants have no CRD, so they are applied by a `psql` Job that authenticates as the **database owner**, never superuser — one transaction that revokes every privilege the role currently holds and re-grants the requested set, so removing a grant from config actually revokes it. |
| MariaDB | `User` CR for the account, one `Grant` CR per requested grant. Fully declarative — no SQL, no Job. |
| Neo4j (Community) | a one-shot `cypher-shell` Job running `CREATE USER ... IF NOT EXISTS`. There is no RBAC to reconcile — any `grants` value throws, `[]` included. |

```typescript
interface IDatabaseRoleConfig {
  namespaces?: string[]; // Secret replication targets. Default: none.
  login?: boolean; // Default: true. false throws on MariaDB and Neo4j.
  grants?: IDatabaseGrant[]; // Omitted = unmanaged; [] = hold nothing. Throws on Neo4j.
  reclaimPolicy?: "retain" | "delete"; // CloudNativePG only; ignored elsewhere. Default: "retain".
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
- `name` contains a backtick, single quote, double quote, backslash, or NUL byte,
  on any engine.

#### Role names are unique per cluster, not per database

`addRole()` is called on a database, but a **login identity is not a database
object** — on both CloudNativePG and MariaDB it lives at the cluster/instance
level and serves every database on it. So the role name you pass must be unique
across the whole cluster, not just the database:

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
back would not be the one you asked for. If you genuinely want *one* role reading
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

Neo4j has no such registry: its provisioning Job runs `CREATE USER ... IF NOT
EXISTS`, which never rewrites an existing account's password, so a duplicate name
cannot produce the password-flapping this rule prevents.

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
nothing is revoked. `grants: []` means the role should hold *no* privileges — a
real desired state, so the reconciling Job still runs and revokes everything.
That is what makes removing the last grant from a config take access away
instead of freezing it. On MariaDB the two coincide (privileges live in `Grant`
CRs, which are deleted — and revoked — when they leave the config).

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

## Provider Options

```typescript
providerOptions: {
  aws: {
    // Network
    fckNatInstanceType: "t4g.nano",
    availabilityZoneCount: 2,
    // Cluster
    autoMode: true,
    addons: ["vpc-cni", "coredns"],
    endpointAccess: "both",
    // State backend
    stateKmsKeyArn: "arn:aws:kms:...",
    stateForceDestroy: false,
  },
  azure: {
    resourceGroupName: "my-rg",  // Required for all Azure resources
    // Network
    subnetCount: 2,
    // Cluster
    azureCni: true,
    virtualNodes: false,
    aadTenantId: "...",
    dnsPrefix: "...",
    // Secrets
    tenantId: "...",             // Required for Key Vault
    objectId: "...",
    sku: "standard",
  },
}
```

## Cloud Target Flexibility

All factory functions accept flexible cloud arguments:

```typescript
// String shorthand (uses DEFAULT_REGIONS)
await createNetwork("prod", { cloud: "aws", ... });

// Explicit target
await createNetwork("prod", { cloud: { provider: "aws", region: "eu-west-1" }, ... });

// Multi-cloud array
await createNetwork("prod", { cloud: ["aws", "azure"], ... });
```

## Direct Cloud Functions (Escape Hatch)

For maximum control, use cloud-specific functions directly via subpath imports:

```typescript
import { createAwsNetwork, createEksCluster } from "@reyemtech/nimbus/aws";
import { createAzureNetwork, createAksCluster } from "@reyemtech/nimbus/azure";
```

Available functions:

- `createAwsNetwork(name, config, options?)` / `createAzureNetwork(name, config, options)`
- `createEksCluster(name, config, network, options?)` / `createAksCluster(name, config, network, options)`
- `createRoute53Dns(name, config)` / `createAzureDns(name, config, options)`
- `createAwsSecrets(name, config)` / `createAzureSecrets(name, config, options)`
- `createAwsStateBackend(name, config, options?)` / `createAzureStateBackend(name, config, options)`

## Escape Hatches

Every resource exposes its cloud-native object via `nativeResource`:

```typescript
import * as aws from "@pulumi/aws";

const cluster = await createCluster("prod", { cloud: "aws", ... }, network) as ICluster;
const eksCluster = cluster.nativeResource as aws.eks.Cluster;
eksCluster.arn.apply(arn => console.log("EKS ARN:", arn));
```
