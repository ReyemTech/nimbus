/**
 * Email transport module — cloud-agnostic SMTP credential provisioning.
 *
 * Supports AWS SES, Resend, Mailgun, and generic SMTP passthrough.
 * All providers return the same IEmailTransport interface with SMTP
 * credentials, optionally stored as a K8s Secret.
 *
 * @module email
 */

import * as crypto from "node:crypto";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ensureNamespace } from "../utils/ensure-namespace";
import { assertNever } from "../types";
import type {
  IEmailTransportConfig,
  ISesTransportConfig,
  ISmtpTransportConfig,
  IResendTransportConfig,
  IMailgunTransportConfig,
  IEmailTransport,
} from "./interfaces";

export type {
  EmailProvider,
  IEmailTransportConfig,
  ISesTransportConfig,
  ISmtpTransportConfig,
  IResendTransportConfig,
  IMailgunTransportConfig,
  IEmailTransport,
} from "./interfaces";
export { EMAIL_PROVIDERS } from "./interfaces";

/**
 * Derive an SES SMTP password from an IAM secret access key.
 *
 * Uses the AWS Signature V4 based algorithm documented at:
 * https://docs.aws.amazon.com/ses/latest/dg/smtp-credentials.html
 */
function deriveSesSmtpPassword(secretKey: string, region: string): string {
  const DATE = "11111111";
  const SERVICE = "ses";
  const TERMINAL = "aws4_request";
  const MESSAGE = "SendRawEmail";
  const VERSION = 0x04;

  let signature = crypto.createHmac("sha256", `AWS4${secretKey}`).update(DATE).digest();
  signature = crypto.createHmac("sha256", signature).update(region).digest();
  signature = crypto.createHmac("sha256", signature).update(SERVICE).digest();
  signature = crypto.createHmac("sha256", signature).update(TERMINAL).digest();
  signature = crypto.createHmac("sha256", signature).update(MESSAGE).digest();

  return Buffer.concat([Buffer.from([VERSION]), signature]).toString("base64");
}

/**
 * Create an email transport with SMTP credentials.
 *
 * @example AWS SES
 * ```typescript
 * const email = createEmailTransport("alerts", {
 *   provider: "ses",
 *   region: "us-east-1",
 *   fromAddress: "alerts@reyem.tech",
 *   awsProvider,
 *   targetNamespace: "observability",
 *   k8sProvider: cluster.provider,
 * });
 * ```
 *
 * @example Generic SMTP
 * ```typescript
 * const email = createEmailTransport("alerts", {
 *   provider: "smtp",
 *   host: "smtp.fastmail.com",
 *   port: 587,
 *   username: "mario@reyem.tech",
 *   passwordSecret: "fastmail-password",
 *   fromAddress: "alerts@reyem.tech",
 * });
 * ```
 */
export function createEmailTransport(name: string, config: IEmailTransportConfig): IEmailTransport {
  switch (config.provider) {
    case "ses":
      return createSesTransport(name, config);
    case "smtp":
      return createSmtpTransport(name, config);
    case "resend":
      return createResendTransport(name, config);
    case "mailgun":
      return createMailgunTransport(name, config);
    default:
      return assertNever(config);
  }
}

// ---------------------------------------------------------------------------
// SES provider
// ---------------------------------------------------------------------------

function createSesTransport(name: string, config: ISesTransportConfig): IEmailTransport {
  // Lazy import to avoid requiring @pulumi/aws when not using SES
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const aws = require("@pulumi/aws");

  const providerOpts = config.awsProvider ? { provider: config.awsProvider } : {};
  const host = `email-smtp.${config.region}.amazonaws.com`;
  const port = 587;

  // IAM user for SES SMTP
  const user = new aws.iam.User(
    `${name}-ses-smtp-user`,
    { name: `${name}-ses-smtp`, path: "/nimbus/", tags: { "managed-by": "nimbus" } },
    providerOpts
  );

  // Inline policy: ses:SendRawEmail on all identities in the account.
  // SES requires permission on BOTH sender and recipient identity ARNs.
  new aws.iam.UserPolicy(
    `${name}-ses-smtp-policy`,
    {
      user: user.name,
      policy: pulumi.output(
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["ses:SendRawEmail", "ses:SendEmail"],
              Resource: "*",
            },
          ],
        })
      ),
    },
    providerOpts
  );

  // Access key
  const accessKey = new aws.iam.AccessKey(
    `${name}-ses-smtp-key`,
    { user: user.name },
    providerOpts
  );

  const username = accessKey.id;
  const password: pulumi.Output<string> = accessKey.secret.apply((secret: string) =>
    deriveSesSmtpPassword(secret, config.region)
  );

  // Optional: SES domain identity + DKIM (full mode)
  let dkimTokens: pulumi.Output<string[]> | undefined;
  if (config.mode === "full") {
    const sesDomain = config.fromAddress.split("@")[1];
    const identity = new aws.ses.DomainIdentity(
      `${name}-ses-domain`,
      { domain: sesDomain },
      providerOpts
    );
    const dkim = new aws.ses.DomainDkim(
      `${name}-ses-dkim`,
      { domain: identity.domain },
      providerOpts
    );
    dkimTokens = dkim.dkimTokens;
  }

  // K8s Secret with SMTP credentials
  let secretName: string | undefined;
  if (config.targetNamespace && config.k8sProvider) {
    secretName = `${name}-ses-smtp`;
    const ns = ensureNamespace(config.targetNamespace, config.k8sProvider);
    new k8s.core.v1.Secret(
      `${name}-ses-smtp-secret`,
      {
        metadata: {
          name: secretName,
          namespace: config.targetNamespace,
          labels: { "app.kubernetes.io/managed-by": "nimbus" },
        },
        stringData: {
          host,
          port: String(port),
          username,
          password,
        },
      },
      { provider: config.k8sProvider, dependsOn: [ns] }
    );
  }

  return {
    name,
    provider: "ses",
    host,
    port,
    username,
    password: pulumi.secret(password),
    fromAddress: config.fromAddress,
    secretName,
    nativeResource: user,
    dkimTokens,
  };
}

// ---------------------------------------------------------------------------
// SMTP passthrough
// ---------------------------------------------------------------------------

function createSmtpTransport(name: string, config: ISmtpTransportConfig): IEmailTransport {
  const host = config.host;
  const port = config.port ?? 587;
  const username = pulumi.output(config.username);

  // Read password from existing K8s Secret
  const srcNamespace = config.passwordSecretNamespace ?? config.targetNamespace ?? "default";
  const srcSecret = config.k8sProvider
    ? k8s.core.v1.Secret.get(
        `${name}-smtp-password-src`,
        pulumi.interpolate`${srcNamespace}/${config.passwordSecret}`,
        { provider: config.k8sProvider }
      )
    : undefined;

  const password = srcSecret
    ? srcSecret.data.apply((d) => Buffer.from(d?.["password"] ?? "", "base64").toString())
    : pulumi.output("");

  // Copy to target namespace if needed
  let secretName: string | undefined;
  let nativeResource: pulumi.Resource = srcSecret as unknown as pulumi.Resource;

  if (config.targetNamespace && config.k8sProvider) {
    secretName = `${name}-smtp`;
    const ns = ensureNamespace(config.targetNamespace, config.k8sProvider);
    const secret = new k8s.core.v1.Secret(
      `${name}-smtp-secret`,
      {
        metadata: {
          name: secretName,
          namespace: config.targetNamespace,
          labels: { "app.kubernetes.io/managed-by": "nimbus" },
        },
        stringData: {
          host,
          port: String(port),
          username: config.username,
          password,
        },
      },
      { provider: config.k8sProvider, dependsOn: [ns] }
    );
    nativeResource = secret;
  }

  return {
    name,
    provider: "smtp",
    host,
    port,
    username,
    password: pulumi.secret(password),
    fromAddress: config.fromAddress,
    secretName,
    nativeResource,
  };
}

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------

function createResendTransport(name: string, config: IResendTransportConfig): IEmailTransport {
  const host = "smtp.resend.com";
  const port = 465;
  const username = pulumi.output("resend");

  // Read API key from K8s Secret → used as SMTP password
  const srcNamespace = config.apiKeySecretNamespace ?? config.targetNamespace ?? "default";
  const srcSecret = config.k8sProvider
    ? k8s.core.v1.Secret.get(
        `${name}-resend-key-src`,
        pulumi.interpolate`${srcNamespace}/${config.apiKeySecret}`,
        { provider: config.k8sProvider }
      )
    : undefined;

  const password = srcSecret
    ? srcSecret.data.apply((d) =>
        Buffer.from(d?.["api-key"] ?? d?.["password"] ?? "", "base64").toString()
      )
    : pulumi.output("");

  let secretName: string | undefined;
  let nativeResource: pulumi.Resource = srcSecret as unknown as pulumi.Resource;

  if (config.targetNamespace && config.k8sProvider) {
    secretName = `${name}-resend-smtp`;
    const ns = ensureNamespace(config.targetNamespace, config.k8sProvider);
    const secret = new k8s.core.v1.Secret(
      `${name}-resend-smtp-secret`,
      {
        metadata: {
          name: secretName,
          namespace: config.targetNamespace,
          labels: { "app.kubernetes.io/managed-by": "nimbus" },
        },
        stringData: { host, port: String(port), username: "resend", password },
      },
      { provider: config.k8sProvider, dependsOn: [ns] }
    );
    nativeResource = secret;
  }

  return {
    name,
    provider: "resend",
    host,
    port,
    username,
    password: pulumi.secret(password),
    fromAddress: config.fromAddress,
    secretName,
    nativeResource,
  };
}

// ---------------------------------------------------------------------------
// Mailgun
// ---------------------------------------------------------------------------

function createMailgunTransport(name: string, config: IMailgunTransportConfig): IEmailTransport {
  const host = "smtp.mailgun.org";
  const port = 587;
  const smtpUsername = `postmaster@${config.domain}`;
  const username = pulumi.output(smtpUsername);

  // Read API key/password from K8s Secret
  const srcNamespace = config.apiKeySecretNamespace ?? config.targetNamespace ?? "default";
  const srcSecret = config.k8sProvider
    ? k8s.core.v1.Secret.get(
        `${name}-mailgun-key-src`,
        pulumi.interpolate`${srcNamespace}/${config.apiKeySecret}`,
        { provider: config.k8sProvider }
      )
    : undefined;

  const password = srcSecret
    ? srcSecret.data.apply((d) =>
        Buffer.from(d?.["password"] ?? d?.["api-key"] ?? "", "base64").toString()
      )
    : pulumi.output("");

  let secretName: string | undefined;
  let nativeResource: pulumi.Resource = srcSecret as unknown as pulumi.Resource;

  if (config.targetNamespace && config.k8sProvider) {
    secretName = `${name}-mailgun-smtp`;
    const ns = ensureNamespace(config.targetNamespace, config.k8sProvider);
    const secret = new k8s.core.v1.Secret(
      `${name}-mailgun-smtp-secret`,
      {
        metadata: {
          name: secretName,
          namespace: config.targetNamespace,
          labels: { "app.kubernetes.io/managed-by": "nimbus" },
        },
        stringData: { host, port: String(port), username: smtpUsername, password },
      },
      { provider: config.k8sProvider, dependsOn: [ns] }
    );
    nativeResource = secret;
  }

  return {
    name,
    provider: "mailgun",
    host,
    port,
    username,
    password: pulumi.secret(password),
    fromAddress: config.fromAddress,
    secretName,
    nativeResource,
  };
}
