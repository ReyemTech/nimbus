/**
 * Email transport interfaces for @reyemtech/nimbus.
 *
 * Cloud-agnostic SMTP credential provisioning — supports AWS SES,
 * Resend, Mailgun, and generic SMTP passthrough.
 *
 * @module email/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type * as k8s from "@pulumi/kubernetes";

/** Supported email transport providers. */
export type EmailProvider = "ses" | "smtp" | "resend" | "mailgun";

/** Typed constant map for EmailProvider string literals. */
export const EMAIL_PROVIDERS = {
  SES: "ses" as const,
  SMTP: "smtp" as const,
  RESEND: "resend" as const,
  MAILGUN: "mailgun" as const,
} satisfies Record<string, EmailProvider>;

/** Common fields for all email transport providers. */
interface IEmailTransportBase {
  /** Email transport provider. */
  readonly provider: EmailProvider;
  /** Sender email address (e.g., "alerts@reyem.tech"). */
  readonly fromAddress: string;
  /** K8s namespace to create the SMTP credentials Secret in. */
  readonly targetNamespace?: string;
  /** K8s provider for creating the credentials Secret. */
  readonly k8sProvider?: k8s.Provider;
}

/**
 * AWS SES — creates IAM user with ses:SendRawEmail permission and
 * derives SMTP password from the IAM secret access key.
 *
 * In "smtp-only" mode (default), no SES identity resources are created.
 * Use this when the domain/email is already verified in SES externally.
 *
 * In "full" mode, also creates SES domain identity + DKIM records.
 * DKIM uses unique selectors that never conflict with existing records.
 */
export interface ISesTransportConfig extends IEmailTransportBase {
  readonly provider: "ses";
  /** AWS region for SES endpoint (e.g., "us-east-1"). */
  readonly region: string;
  /** "smtp-only" = just IAM + creds (default). "full" = also SES identity + DKIM. */
  readonly mode?: "smtp-only" | "full";
  /** AWS provider for IAM + SES resources. */
  readonly awsProvider?: pulumi.ProviderResource;
}

/**
 * Generic SMTP passthrough — use any SMTP server directly.
 * Password is read from an existing K8s Secret.
 */
export interface ISmtpTransportConfig extends IEmailTransportBase {
  readonly provider: "smtp";
  /** SMTP server hostname. */
  readonly host: string;
  /** SMTP port. Default: 587. */
  readonly port?: number;
  /** SMTP AUTH username. */
  readonly username: string;
  /** K8s Secret name containing the SMTP password (key: "password"). */
  readonly passwordSecret: string;
  /** K8s namespace where passwordSecret lives. Default: same as targetNamespace. */
  readonly passwordSecretNamespace?: string;
  /** Require TLS. Default: true. */
  readonly requireTls?: boolean;
}

/**
 * Resend — uses API key as SMTP password.
 * SMTP host: smtp.resend.com, username: "resend".
 */
export interface IResendTransportConfig extends IEmailTransportBase {
  readonly provider: "resend";
  /** K8s Secret name containing the Resend API key (key: "api-key"). */
  readonly apiKeySecret: string;
  /** K8s namespace where apiKeySecret lives. */
  readonly apiKeySecretNamespace?: string;
}

/**
 * Mailgun — uses API key as SMTP password.
 * SMTP host: smtp.mailgun.org, username: postmaster@{domain}.
 */
export interface IMailgunTransportConfig extends IEmailTransportBase {
  readonly provider: "mailgun";
  /** Mailgun sending domain (e.g., "reyem.tech"). */
  readonly domain: string;
  /** K8s Secret name containing the Mailgun SMTP password (key: "password"). */
  readonly apiKeySecret: string;
  /** K8s namespace where apiKeySecret lives. */
  readonly apiKeySecretNamespace?: string;
}

/** Discriminated union of all email transport provider configs. */
export type IEmailTransportConfig =
  | ISesTransportConfig
  | ISmtpTransportConfig
  | IResendTransportConfig
  | IMailgunTransportConfig;

/** Unified email transport output — same shape regardless of provider. */
export interface IEmailTransport {
  /** Logical name of the transport. */
  readonly name: string;
  /** Provider used. */
  readonly provider: EmailProvider;
  /** SMTP server hostname. */
  readonly host: string;
  /** SMTP server port. */
  readonly port: number;
  /** SMTP AUTH username. */
  readonly username: pulumi.Output<string>;
  /** SMTP AUTH password (or derived SMTP password for SES). */
  readonly password: pulumi.Output<string>;
  /** Sender email address. */
  readonly fromAddress: string;
  /** K8s Secret name containing SMTP credentials (if targetNamespace was set). */
  readonly secretName?: string;
  /** Underlying Pulumi resource for dependency wiring. */
  readonly nativeResource: pulumi.Resource;
  /** DKIM CNAME records to add (SES "full" mode only). */
  readonly dkimTokens?: pulumi.Output<string[]>;
}
