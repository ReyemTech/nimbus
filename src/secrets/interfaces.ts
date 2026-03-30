/**
 * Secrets interfaces for @reyemtech/nimbus.
 *
 * Abstracts secret management across HashiCorp Vault (in-cluster),
 * AWS Secrets Manager, Azure Key Vault, and GCP Secret Manager.
 *
 * @module secrets/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type { CloudArg, ResolvedCloudTarget } from "../types";

/** Supported secret backends. */
export type SecretBackend =
  | "vault" // HashiCorp Vault (in-cluster, used by ReyemTech + DoNotCarry)
  | "aws-secrets-manager" // AWS Secrets Manager
  | "azure-key-vault" // Azure Key Vault (used by MetrixGroup)
  | "gcp-secret-manager"; // GCP Secret Manager

/** Typed constant map for SecretBackend string literals. */
export const SECRET_BACKENDS = {
  VAULT: "vault" as const,
  AWS_SECRETS_MANAGER: "aws-secrets-manager" as const,
  AZURE_KEY_VAULT: "azure-key-vault" as const,
  GCP_SECRET_MANAGER: "gcp-secret-manager" as const,
} satisfies Record<string, SecretBackend>;

/** Reference to a secret (path + optional key within the secret). */
export interface ISecretRef {
  /** Secret path (e.g., "operators/mysql" or "production"). */
  readonly path: string;
  /** Specific key within the secret (e.g., "root" for the root password). */
  readonly key?: string;
}

/**
 * Secrets configuration input.
 *
 * @example
 * ```typescript
 * // Vault (default for in-cluster)
 * const config: ISecretsConfig = {
 *   cloud: "aws",
 *   backend: "vault",
 *   vaultAddress: "https://vault.reyem.tech",
 * };
 *
 * // Azure Key Vault
 * const config: ISecretsConfig = {
 *   cloud: "azure",
 *   backend: "azure-key-vault",
 * };
 * ```
 */
export interface ISecretsConfig {
  /** Cloud provider target or multi-cloud array. */
  readonly cloud: CloudArg;
  /** Default: "vault" if Vault is in the platform stack, cloud-native otherwise. */
  readonly backend?: SecretBackend;
  /** Vault address (required if backend is "vault"). */
  readonly vaultAddress?: string;
  /** Resource tags applied to the secret store. */
  readonly tags?: Readonly<Record<string, string>>;
}

/**
 * Secrets output — the created secret store.
 *
 * Provides unified put/get operations regardless of backend.
 */
export interface ISecrets {
  /** Logical name of the secret store resource. */
  readonly name: string;
  /** Resolved cloud target this secret store was provisioned on. */
  readonly cloud: ResolvedCloudTarget;
  /** Active secret backend for this store. */
  readonly backend: SecretBackend;

  /**
   * Store a secret.
   *
   * @param path - Secret path
   * @param data - Key-value pairs to store
   */
  putSecret(path: string, data: Record<string, pulumi.Input<string>>): void;

  /**
   * Get a reference to a secret value (for use in other resources).
   *
   * @param ref - Secret reference (path + optional key)
   * @returns The secret value as a Pulumi Output
   */
  getSecretRef(ref: ISecretRef): pulumi.Output<string>;

  /** Escape hatch: cloud-native secret store resource. */
  readonly nativeResource: pulumi.Resource;
}
