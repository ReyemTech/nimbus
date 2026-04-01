# Secrets Management

How nimbus manages secrets across the stack: database credentials, Vault-backed secrets via External Secrets Operator (ESO), and static secrets for ArgoCD applications.

## Overview

Nimbus provides three secrets mechanisms, each for a different use case:

| Mechanism | Source | Use Case | Created By |
|-----------|--------|----------|------------|
| **Database secrets** | Operator (CNPG/MariaDB) | Per-database user credentials | `createDatabase()` |
| **External secrets** | Vault via ESO | App config, API keys, env vars | `createExternalSecrets()` |
| **Static secrets** | Random or explicit values | One-off secrets (salts, encryption keys) | `createAppSecrets()` |

All three produce standard K8s Secrets that can be consumed via `envFrom`, `env[].valueFrom`, or volume mounts.

## Architecture

```
                      Vault (KV-v2)
                          |
                    ClusterSecretStore
                     "vault-backend"
                          |
                   ExternalSecret CRD
                    (nimbus-managed)
                          |
                          v
    +------------------+     +------------------+     +------------------+
    | K8s Secret       |     | K8s Secret       |     | K8s Secret       |
    | (from Vault/ESO) |     | (from DB operator)|    | (static/random)  |
    +------------------+     +------------------+     +------------------+
           |                        |                        |
           +------------------------+------------------------+
                                    |
                              Helm values
                         (envFrom / env / volumes)
```

---

## Database Secrets

When you create a database via `createOperator().createDatabase()`, nimbus automatically creates a K8s Secret in each target namespace with **standardized keys**.

### Standardized Keys

Every database user secret contains the same six keys, regardless of engine:

| Key | Description | Example (CNPG) | Example (MariaDB) |
|-----|-------------|-----------------|---------------------|
| `host` | Database hostname | `pgsql-main-rw.data.svc.cluster.local` | `mariadb-main.data.svc.cluster.local` |
| `port` | Connection port | `5432` | `3306` |
| `username` | Database user | `langfuse` | `kimai` |
| `password` | User password | `zAm9O9a0...` | `pn88r4IG...` |
| `database` | Database name | `langfuse` | `kimai` |
| `uri` | Full connection URI | `postgresql://langfuse:...@host:5432/langfuse?sslmode=require` | `mysql://kimai:...@host:3306/kimai` |

### Secret Naming Convention

```
{cluster}-{database}-{suffix}
```

| Engine | Suffix | Example |
|--------|--------|---------|
| CNPG (PostgreSQL) | `-pg` | `pgsql-main-langfuse-pg` |
| MariaDB | `-mariadb` | `mariadb-main-kimai-mariadb` |

### How It Works

```typescript
const operator = createOperator("pgsql-main", {
  type: "cnpg",
  cloud: "aws",
  // ...
}, provider);

const cluster = operator.createCluster();

// Creates user + database + replicated secrets
cluster.createDatabase("langfuse", {
  namespaces: ["langfuse"],  // Secret replicated here
  owner: "langfuse",
});
// Result: K8s Secret "pgsql-main-langfuse-pg" in namespace "langfuse"
//         with keys: host, port, username, password, database, uri
```

### Using in Helm Values

```typescript
// Option 1: Full env via envFrom (all 6 keys become env vars)
{
  envFrom: [
    { secretRef: { name: "pgsql-main-langfuse-pg" } },
  ],
}

// Option 2: Individual env vars
{
  env: [
    { name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: "pgsql-main-langfuse-pg", key: "uri" } } },
    { name: "DB_HOST",      valueFrom: { secretKeyRef: { name: "pgsql-main-langfuse-pg", key: "host" } } },
    { name: "DB_PASSWORD",  valueFrom: { secretKeyRef: { name: "pgsql-main-langfuse-pg", key: "password" } } },
  ],
}

// Option 3: Via nimbus registry lookup
const pg = nimbus.lookup("pgsql-main");
{
  env: [
    { name: "DB_HOST", value: pg.endpoint },
    { name: "DB_PASSWORD", valueFrom: pg.secretRef("password") },
  ],
}
```

### Labels

All database secrets include labels for filtering:

```yaml
labels:
  app.kubernetes.io/managed-by: nimbus
  nimbus/cluster: pgsql-main
  nimbus/database: langfuse
```

---

## External Secrets (Vault via ESO)

For application configuration, API keys, and environment variables stored in HashiCorp Vault. Uses External Secrets Operator (ESO) to sync Vault secrets to K8s Secrets.

### Prerequisites

- Vault deployed via nimbus platform stack (`vault: { enabled: true }`)
- External Secrets Operator deployed (`externalSecrets: { enabled: true }`)
- ClusterSecretStore `vault-backend` is `Ready` (auto-configured by nimbus)

### Writing Secrets to Vault

Before using `createExternalSecrets()`, secrets must exist in Vault:

```bash
# Via Vault CLI
vault kv put secret/langfuse/env \
  NEXTAUTH_SECRET="..." \
  SALT="..." \
  ENCRYPTION_KEY="..." \
  LANGFUSE_API_KEY="..."

# Via Vault UI
# Navigate to secret/langfuse/env and add key-value pairs
```

### API

#### Via ArgoApp (recommended)

```typescript
const app = tools.createApp("langfuse", { ... });

const env = app.createExternalSecrets("langfuse-env", {
  dataFrom: [{ key: "secret/data/langfuse/env" }],
});
```

#### Standalone

```typescript
import { createExternalSecrets } from "@reyemtech/nimbus";

const env = createExternalSecrets("langfuse-env", {
  namespace: "langfuse",
  cluster,
  secrets: {
    dataFrom: [{ key: "secret/data/langfuse/env" }],
  },
});
```

### Patterns

#### Pattern 1: Bulk Pull (entire env from one Vault path)

All keys at the Vault path become keys in the K8s Secret:

```typescript
app.createExternalSecrets("langfuse-env", {
  dataFrom: [{ key: "secret/data/langfuse/env" }],
});
```

Vault path `secret/data/langfuse/env`:
```json
{
  "NEXTAUTH_SECRET": "abc123",
  "SALT": "def456",
  "ENCRYPTION_KEY": "ghi789"
}
```

Resulting K8s Secret `langfuse-env`:
```yaml
data:
  NEXTAUTH_SECRET: YWJjMTIz
  SALT: ZGVmNDU2
  ENCRYPTION_KEY: Z2hpNzg5
```

#### Pattern 2: Individual Key Mappings

Cherry-pick specific keys from different Vault paths:

```typescript
app.createExternalSecrets("langfuse-secrets", {
  data: {
    "NEXTAUTH_SECRET": { key: "secret/data/langfuse/env", property: "NEXTAUTH_SECRET" },
    "SMTP_PASSWORD":   { key: "secret/data/shared/smtp",  property: "password" },
    "S3_SECRET_KEY":   { key: "secret/data/shared/aws",   property: "secret_access_key" },
  },
});
```

#### Pattern 3: Mixed (Bulk + Individual Overrides)

Pull bulk env from Vault, then add/override specific keys from other paths:

```typescript
app.createExternalSecrets("langfuse-env", {
  // Bulk: all keys from this Vault path
  dataFrom: [{ key: "secret/data/langfuse/env" }],
  // Individual: override or add from other paths
  data: {
    "SMTP_PASSWORD": { key: "secret/data/shared/smtp", property: "password" },
    "S3_SECRET_KEY": { key: "secret/data/shared/aws",  property: "secret_access_key" },
  },
});
```

ESO merges both: `dataFrom` keys form the base, `data` keys add or override.

### Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `data` | `Record<string, { key, property? }>` | — | Individual key mappings |
| `dataFrom` | `Array<{ key }>` | — | Bulk pull from Vault paths |
| `store` | `string` | `"vault-backend"` | ClusterSecretStore name |
| `refreshInterval` | `string` | `"1h"` | How often ESO re-syncs from Vault |

At least one of `data` or `dataFrom` is required.

### Typed References

The return value provides a `ref()` helper for Helm values:

```typescript
const secrets = app.createExternalSecrets("langfuse-secrets", {
  data: {
    "NEXTAUTH_SECRET": { key: "secret/data/langfuse/env", property: "NEXTAUTH_SECRET" },
  },
});

secrets.name;                    // "langfuse-secrets"
secrets.ref("NEXTAUTH_SECRET"); // { secretKeyRef: { name: "langfuse-secrets", key: "NEXTAUTH_SECRET" } }
```

> **Note:** When using `dataFrom`, `ref()` accepts any key (since the keys are determined by Vault at runtime, not at build time).

---

## Static Secrets

For one-off secrets that don't need Vault — random passwords, salts, encryption keys. Created directly as K8s Secrets using `@pulumi/random`.

### API

#### Via ArgoApp

```typescript
const secrets = app.createSecrets("langfuse-generated", {
  salt: { random: 64 },
  nextauthSecret: { random: 64 },
  encryptionKey: { random: 64 },
});
```

#### Standalone

```typescript
import { createAppSecrets } from "@reyemtech/nimbus";

const secrets = createAppSecrets("langfuse-generated", {
  namespace: "langfuse",
  cluster,
  secrets: {
    salt: { random: 64 },
    apiKey: { value: someExistingOutput },
  },
});
```

### Field Types

| Field | Description |
|-------|-------------|
| `{ random: N }` | Generate a random alphanumeric string of length N |
| `{ value: string \| Output }` | Use an explicit value (string or Pulumi Output) |

### Typed References

```typescript
secrets.name;           // "langfuse-generated"
secrets.ref("salt");    // { secretKeyRef: { name: "langfuse-generated", key: "salt" } }
```

---

## Combining All Three

A typical app uses multiple secret sources. Here's how they work together:

```typescript
import { createArgoCD, nimbus } from "@reyemtech/nimbus";

// Database credentials (auto-created by operator)
// Secret "pgsql-main-langfuse-pg" already exists in namespace "langfuse"
// Keys: host, port, username, password, database, uri

// Vault-backed env vars
const env = langfuseApp.createExternalSecrets("langfuse-env", {
  dataFrom: [{ key: "secret/data/langfuse/env" }],
  data: {
    "SMTP_PASSWORD": { key: "secret/data/shared/smtp", property: "password" },
  },
});

// Generated secrets (random values)
const generated = langfuseApp.createSecrets("langfuse-generated", {
  salt: { random: 64 },
  encryptionKey: { random: 64 },
});

// Helm values — combine all three
tools.createApp("langfuse", {
  source: {
    repo: charts,
    chart: "langfuse",
    values: {
      // Bulk env from Vault
      extraEnvFrom: [
        { secretRef: { name: env.name } },
      ],
      // Individual env vars from database + generated secrets
      extraEnv: [
        { name: "DATABASE_URL",    valueFrom: { secretKeyRef: { name: "pgsql-main-langfuse-pg", key: "uri" } } },
        { name: "SALT",            valueFrom: generated.ref("salt") },
        { name: "ENCRYPTION_KEY",  valueFrom: generated.ref("encryptionKey") },
      ],
    },
  },
  namespace: "langfuse",
  syncPolicy: { automated: true, selfHeal: true, prune: true },
});
```

### Decision Guide

| Question | Use |
|----------|-----|
| Database credentials? | **Database secrets** — auto-created, standardized keys |
| App config, API keys, env vars? | **External secrets** — Vault-backed, ESO-synced |
| Random passwords, salts, one-off values? | **Static secrets** — `@pulumi/random` generated |
| Need to rotate? | **External secrets** — update in Vault, ESO re-syncs |
| Shared across apps? | **External secrets** with shared Vault path |
| Sensitive infra credentials? | **Database secrets** (operator-managed) or **External secrets** (Vault) |

### Secret Lifecycle

| Type | Rotation | Drift Detection | Source of Truth |
|------|----------|-----------------|-----------------|
| Database | Operator-managed (stable across deploys) | Pulumi `ignoreChanges` on data | Operator CRD |
| External | Vault + ESO refresh interval | ESO reconciliation loop | Vault |
| Static | Manual (redeploy to regenerate) | Pulumi state | Pulumi state |

---

## Nimbus Resource Registry

The global `nimbus` singleton registers all databases and caches for cross-module discovery:

```typescript
// Auto-registered by createCache(), createDatabase(), etc.
const redis = nimbus.lookup("redis-main");
const pg = nimbus.lookup("pgsql-main");

redis.endpoint;          // "redis-main-redis-headless.data.svc.cluster.local"
redis.port;              // 26379
redis.secret();          // { existingSecret: "redis-main-redis", existingSecretPasswordKey: "redis-password" }
redis.secretRef();       // { secretKeyRef: { name: "redis-main-redis", key: "redis-password" } }
redis.connectionString() // Output<"redis://redis-main-redis-headless.data.svc:26379">

pg.endpoint;             // "pgsql-main-rw.data.svc.cluster.local"
pg.port;                 // 5432
pg.secretRef("password") // { secretKeyRef: { name: "pgsql-main-superuser", key: "password" } }
```

> **Note:** Registry lookups reference the **cluster-level** secret (superuser), not per-database user secrets. For app-level access, use the per-database secret directly (e.g., `pgsql-main-langfuse-pg`).

---

## Vault Setup

Nimbus auto-configures the full Vault + ESO pipeline:

1. **Vault deployment** — Helm chart with auto-unseal (AWS KMS)
2. **Bootstrap sidecar** — initializes Vault, enables KV-v2, configures K8s auth, creates ESO role
3. **External Secrets Operator** — Helm chart with fixed service account name `external-secrets`
4. **ClusterSecretStore** — `vault-backend`, authenticates to Vault via K8s auth with role `eso`

All of this is configured automatically when both `vault` and `externalSecrets` are enabled in the platform stack:

```typescript
const platform = createPlatformStack("reyemtech", {
  cluster,
  domain: "reyem.ca",
  vault: {
    enabled: true,
    autoUnseal: { provider: "awskms", region: "us-east-1", awsProvider },
  },
  externalSecrets: { enabled: true },
});
```

### Vault Paths Convention

```
secret/data/{app}/env          # App-specific environment variables
secret/data/{app}/{purpose}    # App-specific grouped secrets
secret/data/shared/{service}   # Shared credentials (SMTP, S3, etc.)
```
