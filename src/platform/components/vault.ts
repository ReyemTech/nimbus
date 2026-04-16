/**
 * Vault secrets management deployment with auto-unseal and bootstrap sidecar.
 *
 * @module platform/components/vault
 */

import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IVaultConfig } from "../interfaces";
import { ensureNamespace } from "../../utils/ensure-namespace";

/** Number of Vault replicas in HA mode (Raft consensus requires odd count). */
const VAULT_HA_REPLICAS = 3;

/**
 * Bootstrap script for the Vault sidecar container.
 *
 * Runs on every pod start. All operations are idempotent:
 * - Init (if first start) → store keys in K8s Secret
 * - Unseal (if Shamir) → read keys from K8s Secret
 * - Enable KV-v2 secrets engine
 * - Enable + configure Kubernetes auth
 * - Create ESO policy + role
 * - Create user-policy for human access
 * - Sleep infinity
 */
const VAULT_BOOTSTRAP_SCRIPT = `#!/bin/sh
set -e
export VAULT_ADDR="http://localhost:8200"

# --- Helpers (no jq/curl — vault image is minimal Alpine) ---

# Extract a JSON string field: json_field '{"key":"val"}' key → val
json_field() {
  echo "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -1
}

# Extract a JSON boolean field: json_bool '{"key":true}' key → true
json_bool() {
  echo "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*\\(true\\|false\\).*/\\1/p' | head -1
}

# Extract JSON array of strings as comma-separated: json_array '{"k":["a","b"]}' k → a,b
json_array() {
  echo "$1" | sed -n 's/.*"'"$2"'"[[:space:]]*:[[:space:]]*\\[\\([^]]*\\)\\].*/\\1/p' | sed 's/"//g; s/ //g' | head -1
}

# K8s API via wget (available in Alpine)
SA_TOKEN=$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)
CA_CERT=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
NAMESPACE=$(cat /var/run/secrets/kubernetes.io/serviceaccount/namespace)
API="https://kubernetes.default.svc"

# Token persistence — write to PVC so it survives pod restarts
TOKEN_FILE="/vault/data/.bootstrap-token"
RECOVERY_FILE="/vault/data/.bootstrap-recovery-keys"

# --- Wait for Vault ---

echo "Waiting for Vault..."
until vault status 2>&1 | grep -q "Initialized"; do sleep 2; done
echo "Vault is reachable"

# --- Init or Unseal ---

STATUS_JSON=$(vault status -format=json 2>/dev/null || true)
INITIALIZED=$(json_bool "$STATUS_JSON" initialized)
SEALED=$(json_bool "$STATUS_JSON" sealed)
SEAL_TYPE=$(json_field "$STATUS_JSON" seal_type)

if [ "$INITIALIZED" = "false" ]; then
  # Detect seal type from text output (more reliable when uninitialized)
  SEAL_TYPE_TEXT=$(vault status 2>&1 | grep "Seal Type" | awk '{print $NF}')
  echo "Initializing Vault (seal_type=$SEAL_TYPE_TEXT)..."
  if [ "$SEAL_TYPE_TEXT" = "shamir" ]; then
    INIT_OUTPUT=$(vault operator init -key-shares=5 -key-threshold=3 -format=json)
  else
    # Auto-unseal (awskms, azurekeyvault, gcpckms): use recovery keys
    INIT_OUTPUT=$(vault operator init -recovery-shares=5 -recovery-threshold=3 -format=json)
  fi
  ROOT_TOKEN=$(json_field "$INIT_OUTPUT" root_token)

  # Auto-unseal uses recovery_keys_b64; Shamir uses unseal_keys_b64
  RECOVERY_KEYS=$(json_array "$INIT_OUTPUT" recovery_keys_b64)
  if [ -z "$RECOVERY_KEYS" ]; then
    RECOVERY_KEYS=$(json_array "$INIT_OUTPUT" unseal_keys_b64)
  fi

  # Store on PVC (survives pod restarts)
  echo "$ROOT_TOKEN" > "$TOKEN_FILE"
  echo "$RECOVERY_KEYS" > "$RECOVERY_FILE"
  chmod 600 "$TOKEN_FILE" "$RECOVERY_FILE"
  echo "Init keys stored on PVC"

  # Shamir: manually unseal (auto-unseal handles itself)
  if [ "$SEAL_TYPE" = "shamir" ]; then
    echo "Unsealing (Shamir)..."
    for i in 1 2 3; do
      KEY=$(echo "$RECOVERY_KEYS" | cut -d',' -f$i)
      vault operator unseal "$KEY"
    done
  fi

  export VAULT_TOKEN="$ROOT_TOKEN"
else
  echo "Vault already initialized (seal_type=$SEAL_TYPE, sealed=$SEALED)"

  # Read root token from PVC
  if [ -f "$TOKEN_FILE" ]; then
    ROOT_TOKEN=$(cat "$TOKEN_FILE")
    echo "Root token loaded from PVC"
  else
    echo "WARNING: No token file found at $TOKEN_FILE"
  fi

  # Shamir: unseal if sealed
  if [ "$SEALED" = "true" ] && [ "$SEAL_TYPE" = "shamir" ] && [ -f "$RECOVERY_FILE" ]; then
    echo "Unsealing (Shamir)..."
    RECOVERY_KEYS=$(cat "$RECOVERY_FILE")
    for i in 1 2 3; do
      KEY=$(echo "$RECOVERY_KEYS" | cut -d',' -f$i)
      vault operator unseal "$KEY"
    done
  fi

  export VAULT_TOKEN="$ROOT_TOKEN"
fi

# Wait for unseal (auto-unseal may take a moment)
echo "Waiting for unseal..."
TRIES=0
while [ $TRIES -lt 60 ]; do
  STATUS=$(vault status -format=json 2>/dev/null || true)
  IS_SEALED=$(json_bool "$STATUS" sealed)
  if [ "$IS_SEALED" = "false" ]; then
    break
  fi
  TRIES=$((TRIES + 1))
  sleep 2
done
echo "Vault is unsealed"

if [ -z "$VAULT_TOKEN" ]; then
  echo "ERROR: No root token available. Cannot configure Vault."
  echo "Create vault-init-keys secret manually with root-token field."
  exec sleep infinity
fi

vault login "$VAULT_TOKEN" > /dev/null 2>&1

# --- Configure secrets engines + auth ---

# Enable KV-v2 (idempotent)
vault secrets list | grep -q "secret/" || vault secrets enable -path=secret kv-v2
echo "KV-v2 engine ready"

# Enable K8s auth (idempotent)
vault auth list | grep -q "kubernetes/" || vault auth enable kubernetes

# Configure K8s auth
vault write auth/kubernetes/config \\
  token_reviewer_jwt="$(cat /var/run/secrets/kubernetes.io/serviceaccount/token)" \\
  kubernetes_host="https://kubernetes.default.svc" \\
  kubernetes_ca_cert=@/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
echo "K8s auth configured"

# ESO policy + role
vault policy write eso - <<'EOPOLICY'
path "secret/data/*" { capabilities = ["read"] }
EOPOLICY

vault write auth/kubernetes/role/eso \\
  bound_service_account_names=external-secrets \\
  bound_service_account_namespaces="*" \\
  policies=eso \\
  ttl=24h
echo "ESO policy and role ready"

# User policy (CRUD for humans)
vault policy write user-policy - <<'EOPOLICY'
path "secret/data/*" { capabilities = ["create", "read", "update", "delete", "list"] }
EOPOLICY

echo "Bootstrap complete — sleeping"
exec sleep infinity
`;

/**
 * Build the HCL config string for Vault server.
 *
 * When auto-unseal is configured, includes the seal stanza.
 * Must include listener + storage because setting standalone.config
 * overrides the chart's auto-generated config.
 */
function buildVaultHclConfig(ha: boolean, sealStanza?: string): string {
  const lines = [
    "ui = true",
    "",
    'listener "tcp" {',
    "  tls_disable = 1",
    '  address     = "[::]:8200"',
    '  cluster_address = "[::]:8201"',
    "}",
    "",
  ];

  if (ha) {
    lines.push('storage "raft" {', '  path = "/vault/data"', "}");
  } else {
    lines.push('storage "file" {', '  path = "/vault/data"', "}");
  }

  if (sealStanza) {
    lines.push("", sealStanza);
  }

  return lines.join("\n");
}

/**
 * Build the seal stanza HCL for the given auto-unseal config.
 */
function buildSealStanza(
  config: IVaultConfig["autoUnseal"],
  kmsKeyId?: pulumi.Output<string>
): string | pulumi.Output<string> | undefined {
  if (!config) return undefined;

  switch (config.provider) {
    case "awskms":
      if (!kmsKeyId) throw new Error("KMS key ID required for awskms seal");
      return kmsKeyId.apply(
        (id) => `seal "awskms" {\n  region     = "${config.region}"\n  kms_key_id = "${id}"\n}`
      );

    case "azurekeyvault":
      throw new Error(
        "Azure Key Vault auto-unseal is not yet implemented. Type is defined for future use."
      );

    case "gcpckms":
      throw new Error(
        "GCP Cloud KMS auto-unseal is not yet implemented. Type is defined for future use."
      );
  }
}

/**
 * Provision AWS KMS resources for Vault auto-unseal.
 *
 * Creates:
 * - KMS key (or uses existing)
 * - IAM user at /nimbus/ path
 * - IAM policy with kms:Encrypt, kms:Decrypt, kms:DescribeKey
 * - IAM access key
 * - K8s Secret with credentials
 *
 * Returns the KMS key ID for the Vault seal stanza.
 */
function provisionAwsKmsUnseal(
  name: string,
  config: Extract<IVaultConfig["autoUnseal"], { provider: "awskms" }>,
  k8sProvider: k8s.Provider
): { kmsKeyId: pulumi.Output<string> } {
  const awsOpts = { provider: config.awsProvider };

  // KMS key
  let kmsKeyId: pulumi.Output<string>;
  if (config.kmsKeyId) {
    kmsKeyId = pulumi.output(config.kmsKeyId);
  } else {
    const key = new aws.kms.Key(
      `${name}-vault-unseal-key`,
      {
        description: "Vault auto-unseal key (managed by nimbus)",
        deletionWindowInDays: 7,
        tags: { "managed-by": "nimbus" },
      },
      awsOpts
    );
    kmsKeyId = key.keyId;
  }

  // IAM user
  const user = new aws.iam.User(
    `${name}-vault-unseal-user`,
    {
      name: `${name}-vault-unseal`,
      path: "/nimbus/",
      tags: { "managed-by": "nimbus" },
    },
    awsOpts
  );

  // IAM policy
  new aws.iam.UserPolicy(
    `${name}-vault-unseal-policy`,
    {
      user: user.name,
      policy: kmsKeyId.apply((id) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["kms:Encrypt", "kms:Decrypt", "kms:DescribeKey"],
              Resource: [`arn:aws:kms:${config.region}:*:key/${id}`],
            },
          ],
        })
      ),
    },
    awsOpts
  );

  // Access key
  const accessKey = new aws.iam.AccessKey(
    `${name}-vault-unseal-access-key`,
    { user: user.name },
    awsOpts
  );

  // K8s Secret with credentials
  new k8s.core.v1.Secret(
    `${name}-vault-unseal-creds`,
    {
      metadata: { name: "vault-unseal-credentials", namespace: "vault" },
      stringData: {
        AWS_ACCESS_KEY_ID: accessKey.id,
        AWS_SECRET_ACCESS_KEY: accessKey.secret,
      },
    },
    { provider: k8sProvider }
  );

  return { kmsKeyId };
}

/**
 * Deploy Vault with optional auto-unseal and bootstrap sidecar.
 */
export function deployVault(
  name: string,
  config: IVaultConfig,
  domain: string,
  provider: k8s.Provider,
  defaultVersion: string | undefined
): k8s.helm.v3.Release {
  const ha = config.ha ?? false;
  const storageSize = config.storageSize ?? "5Gi";
  const ingressHost = config.ingressHost ?? `vault.${domain}`;
  const certName = domain.replace(/\./g, "-");
  const bootstrap = config.bootstrap ?? true;

  // Auto-unseal: provision cloud resources + build seal stanza
  let sealStanza: string | pulumi.Output<string> | undefined;
  const extraSecretEnvVars: Record<string, unknown>[] = [];

  if (config.autoUnseal) {
    switch (config.autoUnseal.provider) {
      case "awskms": {
        const { kmsKeyId } = provisionAwsKmsUnseal(name, config.autoUnseal, provider);
        sealStanza = buildSealStanza(config.autoUnseal, kmsKeyId);
        extraSecretEnvVars.push(
          {
            envName: "AWS_ACCESS_KEY_ID",
            secretName: "vault-unseal-credentials",
            secretKey: "AWS_ACCESS_KEY_ID",
          },
          {
            envName: "AWS_SECRET_ACCESS_KEY",
            secretName: "vault-unseal-credentials",
            secretKey: "AWS_SECRET_ACCESS_KEY",
          }
        );
        break;
      }
      case "azurekeyvault":
        throw new Error("Azure Key Vault auto-unseal is not yet implemented.");
      case "gcpckms":
        throw new Error("GCP Cloud KMS auto-unseal is not yet implemented.");
    }
  }

  // Bootstrap sidecar: ConfigMap + RBAC
  const vaultDependencies: pulumi.Resource[] = [];

  if (bootstrap) {
    const bootstrapConfigMap = new k8s.core.v1.ConfigMap(
      `${name}-vault-bootstrap-script`,
      {
        metadata: { name: "vault-bootstrap", namespace: "vault" },
        data: { "bootstrap.sh": VAULT_BOOTSTRAP_SCRIPT },
      },
      { provider }
    );
    vaultDependencies.push(bootstrapConfigMap);

    // Token review delegation (for K8s auth config)
    new k8s.rbac.v1.ClusterRoleBinding(
      `${name}-vault-auth-delegator`,
      {
        metadata: { name: "vault-auth-delegator" },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: "system:auth-delegator",
        },
        subjects: [{ kind: "ServiceAccount", name: "vault", namespace: "vault" }],
      },
      { provider }
    );

    // Secret CRUD in vault namespace (for storing init keys)
    const secretRole = new k8s.rbac.v1.Role(
      `${name}-vault-secret-manager`,
      {
        metadata: { name: "vault-secret-manager", namespace: "vault" },
        rules: [
          {
            apiGroups: [""],
            resources: ["secrets"],
            verbs: ["get", "create", "update"],
          },
        ],
      },
      { provider }
    );

    new k8s.rbac.v1.RoleBinding(
      `${name}-vault-secret-manager-binding`,
      {
        metadata: {
          name: "vault-secret-manager",
          namespace: "vault",
        },
        roleRef: {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "Role",
          name: "vault-secret-manager",
        },
        subjects: [{ kind: "ServiceAccount", name: "vault", namespace: "vault" }],
      },
      { provider, dependsOn: [secretRole] }
    );
  }

  // Build server values
  const serverValues: Record<string, unknown> = {
    standalone: { enabled: !ha },
    ha: ha
      ? {
          enabled: true,
          replicas: VAULT_HA_REPLICAS,
          raft: { enabled: true },
        }
      : { enabled: false },
    dataStorage: { size: storageSize },
    ingress: {
      enabled: true,
      ingressClassName: "traefik",
      hosts: [{ host: ingressHost }],
      annotations: {
        "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
      },
      tls: [{ hosts: [ingressHost], secretName: `${certName}-wildcard-tls` }],
    },
  };

  // Auto-unseal: inject config + credentials
  if (sealStanza) {
    const configKey = ha ? "ha" : "standalone";
    const configObj = serverValues[configKey] as Record<string, unknown>;
    if (typeof sealStanza === "string") {
      configObj["config"] = buildVaultHclConfig(ha, sealStanza);
    } else {
      // pulumi.Output<string>
      configObj["config"] = sealStanza.apply((seal) => buildVaultHclConfig(ha, seal));
    }
  }

  if (extraSecretEnvVars.length > 0) {
    serverValues["extraSecretEnvironmentVars"] = extraSecretEnvVars;
  }

  // Bootstrap sidecar
  if (bootstrap) {
    serverValues["extraContainers"] = [
      {
        name: "bootstrap",
        image: "hashicorp/vault:latest",
        command: ["sh", "/scripts/bootstrap.sh"],
        env: [{ name: "VAULT_ADDR", value: "http://localhost:8200" }],
        volumeMounts: [
          { name: "bootstrap-script", mountPath: "/scripts" },
          { name: "data", mountPath: "/vault/data" },
        ],
        resources: {
          requests: { cpu: "1m", memory: "64Mi" },
          limits: { cpu: "50m", memory: "128Mi" },
        },
      },
    ];
    serverValues["volumes"] = [
      {
        name: "bootstrap-script",
        configMap: { name: "vault-bootstrap", defaultMode: 493 },
      },
    ];
  }

  ensureNamespace("vault", provider);

  return new k8s.helm.v3.Release(
    `${name}-vault`,
    {
      chart: "vault",
      repositoryOpts: { repo: "https://helm.releases.hashicorp.com" },
      version: config.version ?? defaultVersion,
      namespace: "vault",
      createNamespace: false,
      values: {
        server: serverValues,
        injector: { enabled: true },
        ...config.values,
      },
    },
    { provider, dependsOn: vaultDependencies }
  );
}
