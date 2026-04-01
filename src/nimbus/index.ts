/**
 * Nimbus global singleton — central config + resource registry.
 *
 * @module nimbus
 */

import type {
  INimbusConfig,
  INimbusResource,
  INimbusResourceRef,
  INotificationsConfig,
} from "./interfaces";
import { NimbusRegistry } from "./registry";

export type {
  INimbusConfig,
  INimbusResource,
  INimbusResourceRef,
  INotificationsConfig,
  INotificationEmailConfig,
  INotificationSlackConfig,
  NimbusResourceType,
} from "./interfaces";

class Nimbus {
  private readonly registry = new NimbusRegistry();
  private config: INimbusConfig = {};

  /** Configure nimbus-wide settings (notifications, etc.). Call once at project top. */
  configure(config: INimbusConfig): void {
    this.config = { ...this.config, ...config };
  }

  /** Get notification config (read by Alertmanager, ArgoCD Notifications, etc.). */
  get notifications(): INotificationsConfig | undefined {
    return this.config.notifications;
  }

  /** Register a resource for cross-module discovery. */
  register(name: string, resource: INimbusResource): void {
    this.registry.register(name, resource);
  }

  /** Look up a registered resource by name. */
  lookup(name: string): INimbusResourceRef {
    return this.registry.lookup(name);
  }

  /** All registered caches. */
  caches(): ReadonlyArray<INimbusResourceRef> {
    return this.registry.caches();
  }

  /** All registered databases. */
  databases(): ReadonlyArray<INimbusResourceRef> {
    return this.registry.databases();
  }

  /** All registered resources. */
  all(): ReadonlyArray<INimbusResourceRef> {
    return this.registry.all();
  }
}

/** Global nimbus singleton. */
export const nimbus = new Nimbus();
