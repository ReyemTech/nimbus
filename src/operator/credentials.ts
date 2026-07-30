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
  const generatedPassword = pulumi.secret(crypto.randomBytes(PASSWORD_BYTES).toString("base64url"));

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
