/**
 * Nimbus global singleton interfaces.
 *
 * Central config, resource registry, and notifications.
 *
 * @module nimbus/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type { IEmailTransport } from "../email/interfaces";

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/** Email notification config — reused by Alertmanager, ArgoCD Notifications, etc. */
export interface INotificationEmailConfig {
  readonly transport: IEmailTransport;
  readonly to: string | string[];
}

/** Slack notification config (future). */
export interface INotificationSlackConfig {
  readonly webhookUrl: pulumi.Input<string>;
  readonly channel: string;
  readonly username?: string;
}

/** Nimbus-wide notification configuration. */
export interface INotificationsConfig {
  readonly email?: INotificationEmailConfig;
  readonly slack?: INotificationSlackConfig;
}

/** Top-level nimbus configuration. */
export interface INimbusConfig {
  readonly notifications?: INotificationsConfig;
}

// ---------------------------------------------------------------------------
// Resource Registry
// ---------------------------------------------------------------------------

/** Resource types that can be registered. */
export type NimbusResourceType =
  | "cache"
  | "database"
  | "object-storage"
  | "operator"
  | "platform"
  | "observability"
  | "access";

/** Base registered resource. */
export interface INimbusResource {
  readonly name: string;
  readonly type: NimbusResourceType;
  readonly namespace: string;
  readonly endpoint: string | pulumi.Output<string>;
  readonly port?: number;
  readonly secretRef?: {
    readonly name: string | pulumi.Output<string>;
    readonly keys: Record<string, string>;
  };
  readonly nativeResource: pulumi.Resource;
}

/** Lookup result with helpers. */
export interface INimbusResourceRef {
  readonly name: string;
  readonly type: NimbusResourceType;
  readonly namespace: string;
  readonly endpoint: string | pulumi.Output<string>;
  readonly port?: number;
  /** Returns { existingSecret: name, existingSecretPasswordKey: defaultKey }. */
  secret(): Record<string, string | pulumi.Output<string>>;
  /** Returns { secretKeyRef: { name, key } }. */
  secretRef(key?: string): { secretKeyRef: { name: string | pulumi.Output<string>; key: string } };
  /** Returns a connection string (e.g., redis://..., postgresql://...). */
  connectionString(): pulumi.Output<string>;
}
