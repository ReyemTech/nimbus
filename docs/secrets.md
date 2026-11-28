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

**`uri` is percent-encoded; the other keys are not.** A URI is a structured
string — `:` splits user from password, `@` splits userinfo from host — so the
username, password and database segment inside `uri` are percent-encoded. A role
named `reporting@corp` appears there as `reporting%40corp`; interpolated raw it
would make every conforming parser read the user as `reporting` and take the host
from the middle of the password. `username`, `password` and `database` stay raw,
because a client consumes those literally rather than parsing them. Read `uri`
with a URI parser (which decodes for you) or read the individual keys — never
split `uri` by hand.

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
2. **Bootstrap sidecar** — initializes Vault, enables KV-v2, and reconciles Kubernetes auth roles and policies
3. **External Secrets Operator** — Helm chart with fixed service account name `external-secrets`
4. **ClusterSecretStore** — `vault-backend`, requests a short-lived `vault`-audience token for the ESO service account and authenticates through role `eso`

All of this is configured automatically when both `vault` and `externalSecrets` are enabled in the platform stack. The fluent `cluster.createPlatformStack()` form is shown below; the standalone `createPlatformStack()` factory remains supported.

```typescript
import * as pulumi from "@pulumi/pulumi";

const config = new pulumi.Config();
const platform = cluster.createPlatformStack("reyemtech", {
  domain: "reyem.ca",
  vault: {
    enabled: true,
    // Optional; defaults to "secret". ESO paths are relative to this mount.
    secretMount: "secret",
    // ESO receives only this path allowlist; it does not inherit human access.
    esoSecretPaths: ["argocd/ghcr-reyemtech"],
    userpassUsers: [
      {
        username: "mariomeyer",
        password: config.requireSecret("vaultUserPassword"),
        policies: ["default", "read-all-secrets"],
      },
    ],
    autoUnseal: { provider: "awskms", region: "us-east-1", awsProvider },
  },
  externalSecrets: { enabled: true },
});
```

Nimbus binds the Vault `eso` role only to `external-secrets` in the
`external-secrets` namespace, with audience `vault` by default. Its KV-v2 policy
grants read access only to paths listed in `esoSecretPaths`; it grants no list
or write access. When Vault and ESO use Nimbus bootstrap, omitting this list
fails deployment rather than granting broad access.

Nimbus also reconciles the read-only Vault policy `read-all-secrets` for the
configured `secretMount`. It grants `read` on KV-v2 data paths and `list`/`read`
on KV-v2 metadata paths so a human can browse and read all secrets in that
mount. It does not grant create, update, delete, or list access to secret data.
Users only receive policies explicitly named in their `policies` array. Add a
separate policy there only when a user intentionally needs additional access.
The `secretMount` defaults to `secret`; treat a non-default mount as a
foundational setting and keep it stable after initial setup.

Pass each userpass password as a Pulumi secret, for example with
`requireSecret()` as shown above or `pulumi.secret(value)`. Nimbus wraps the
input as secret data again when creating the Kubernetes Secret, mounts it only
into the Vault bootstrap sidecar, and sends it to Vault from a file reference
so it does not appear in a command argument or bootstrap ConfigMap. Never put
passwords in ordinary config, source control, logs, or stack exports. Configure
the value with `pulumi config set --secret vaultUserPassword`.

The sidecar enables userpass only when `userpassUsers` is non-empty, preserves
all existing Vault auth methods, and periodically reconciles configured
usernames, passwords, and policy assignments. Password updates are picked up
after Kubernetes projects the updated Secret and the next reconciliation
(every five minutes). Removing a user from Nimbus configuration does not delete
the Vault account or revoke its tokens; remove the account and revoke tokens
explicitly when access should end. Updating a user's policy assignment affects
new logins. Already issued tokens retain their existing policy assignment until
they expire or are revoked, so revoke and reissue a token when access must
change immediately. Editing a policy's rules affects tokens that already carry
that policy on subsequent requests.

`userpassUsers` requires the bootstrap sidecar. Bootstrap reconciles users with
a short-lived Kubernetes-authenticated token and revokes it after each pass;
it does not keep a root token. The ESO policy remains limited to
`esoSecretPaths`, regardless of any human user's policies.

Vault uses its rotating Kubernetes ServiceAccount token for TokenReview. Nimbus
uses the stable `vault` ServiceAccount and keeps its `system:auth-delegator`
binding and bootstrap role aligned. Do not override
`values.server.serviceAccount.name`; changing this identity would strand the
bootstrap role after root-token revocation. ESO receives a separate short-lived
projected token. During first bootstrap, Nimbus writes Vault's init response to
a mode-600 temporary file on the Vault data PVC so a restarted sidecar can
resume. After setup succeeds, it revokes the root token and removes the handoff
file. It never writes token values to logs, Pulumi outputs, or Pulumi state. A
failed bootstrap keeps the handoff until reconciliation succeeds. On upgrade,
Nimbus also revokes and removes the legacy root-token file. Existing Kubernetes
auth mounts and userpass users remain enabled.

Adding `userpassUsers` to an existing Vault stack is an in-place reconciliation:
Nimbus adds a Kubernetes Secret and updates the bootstrap sidecar configuration;
it does not replace the Vault release, reinitialize Vault, or remove existing
accounts. If the configured username already exists, Nimbus updates that
userpass account's password and token policy assignments.

### Upgrade and migration

Before upgrading an existing Vault + ESO stack, add every path used by
ExternalSecrets to `vault.esoSecretPaths`. For the GHCR ExternalSecret, add
`"argocd/ghcr-reyemtech"`. The preview shows a bootstrap ConfigMap name change
and a Vault pod-template update. Nimbus rolls the Vault server so bootstrap
reconciles automatically; standalone mode has a brief restart window, while HA
restarts one pod at a time. The upgrade corrects TokenReview identity, narrows
the ESO role, and removes the legacy root-token file without disabling
Kubernetes auth or userpass. With `vault.bootstrap: false`, manage these Vault
auth settings externally.

### Break-glass root-token recovery

Nimbus revokes the initialization root token after bootstrap. Do not restore a
persistent root token or enable unauthenticated root generation. Vault 2.x
requires an authenticated token for the root-generation endpoints. Nimbus
provisions a dedicated `vault-root-recovery` Kubernetes auth role with only the
capabilities needed for that ceremony. Its tokens have a 15-minute TTL, no
default policy, and cannot read secrets or administer other Vault paths. The
regular `vault-bootstrap` role does not receive `sys/generate-root` access.

For an emergency task, an operator with permission to exec into the Vault
bootstrap container can obtain the dedicated token there. Find the Vault server
pod, then open a shell in its `bootstrap` container:

```sh
kubectl exec -it -n vault <vault-server-pod> -c bootstrap -- sh
JWT=$(cat /var/run/vault-bootstrap-token/token)
VAULT_TOKEN=$(printf '%s' "$JWT" | vault write -field=token \
  auth/kubernetes/login role=vault-root-recovery jwt=-)
unset JWT
export VAULT_TOKEN
```

Use `vault operator generate-root -init`, provide three of the five recovery
shares to complete the configured 3-of-5 quorum, and decode the returned
encoded token using the one-time password. Keep the nonce, OTP, shares, encoded
token, and decoded root token out of logs, Pulumi outputs/state, shell history,
and tickets. Capture the decoded root token without printing it, use it only
for the emergency administrative task, then revoke it immediately with
`vault token revoke -self` and unset `VAULT_TOKEN`. The recovery-role token
expires after 15 minutes even if the operator forgets to revoke it.

This recovery role is deliberately separate from bootstrap and requires both
Kubernetes access to the Vault bootstrap pod and the recovery-share quorum.
Nimbus creates the role only when the bootstrap sidecar is enabled; with
`vault.bootstrap: false`, configure the equivalent policy and Kubernetes role
through your external Vault administration process.
HashiCorp documents the [authenticated generate-root endpoints](https://developer.hashicorp.com/vault/api-docs/system/generate-root)
and the [root-token recovery procedure](https://developer.hashicorp.com/vault/docs/troubleshoot/generate-root-token).

### Vault Paths Convention

```
secret/data/{app}/env          # App-specific environment variables
secret/data/{app}/{purpose}    # App-specific grouped secrets
secret/data/shared/{service}   # Shared credentials (SMTP, S3, etc.)
```
