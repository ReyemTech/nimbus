/**
 * Nimbus resource registry — global Map for cross-module discovery.
 *
 * @module nimbus/registry
 */

import * as pulumi from "@pulumi/pulumi";
import type {
  INimbusResource,
  INimbusResourceRef,
  NimbusResourceType,
} from "./interfaces";

/**
 * Wrap a registered resource with helper methods.
 */
function wrapResource(resource: INimbusResource): INimbusResourceRef {
  return {
    name: resource.name,
    type: resource.type,
    namespace: resource.namespace,
    endpoint: resource.endpoint,
    port: resource.port,

    secret(): Record<string, string | pulumi.Output<string>> {
      if (!resource.secretRef) {
        throw new Error(`Resource "${resource.name}" has no secret reference`);
      }
      const defaultKey = Object.values(resource.secretRef.keys)[0] ?? "password";
      return {
        existingSecret: resource.secretRef.name,
        existingSecretPasswordKey: defaultKey,
      };
    },

    secretRef(key?: string) {
      if (!resource.secretRef) {
        throw new Error(`Resource "${resource.name}" has no secret reference`);
      }
      const resolvedKey = key
        ? (resource.secretRef.keys[key] ?? key)
        : Object.values(resource.secretRef.keys)[0] ?? "password";
      return {
        secretKeyRef: {
          name: resource.secretRef.name,
          key: resolvedKey,
        },
      };
    },

    connectionString(): pulumi.Output<string> {
      const ep = pulumi.output(resource.endpoint);
      const port = resource.port;

      switch (resource.type) {
        case "cache":
          return ep.apply((e) => `redis://${e}${port ? `:${port}` : ""}`);
        case "database":
          return ep.apply((e) => `postgresql://${e}${port ? `:${port}` : ""}`);
        default:
          return ep.apply((e) => `${e}${port ? `:${port}` : ""}`);
      }
    },
  };
}

/**
 * Resource registry — simple Map with typed queries.
 */
export class NimbusRegistry {
  private readonly resources = new Map<string, INimbusResource>();

  register(name: string, resource: INimbusResource): void {
    if (this.resources.has(name)) {
      throw new Error(`Resource "${name}" is already registered`);
    }
    this.resources.set(name, resource);
  }

  lookup(name: string): INimbusResourceRef {
    const resource = this.resources.get(name);
    if (!resource) {
      throw new Error(
        `Resource "${name}" not found. Registered: ${[...this.resources.keys()].join(", ") || "(none)"}`
      );
    }
    return wrapResource(resource);
  }

  caches(): ReadonlyArray<INimbusResourceRef> {
    return this.byType("cache");
  }

  databases(): ReadonlyArray<INimbusResourceRef> {
    return this.byType("database");
  }

  all(): ReadonlyArray<INimbusResourceRef> {
    return [...this.resources.values()].map(wrapResource);
  }

  private byType(type: NimbusResourceType): ReadonlyArray<INimbusResourceRef> {
    return [...this.resources.values()]
      .filter((r) => r.type === type)
      .map(wrapResource);
  }
}
