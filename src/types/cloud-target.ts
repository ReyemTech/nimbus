/**
 * Cloud target types for @reyemtech/nimbus.
 *
 * Defines how users specify which cloud provider(s) and region(s)
 * to deploy to. Supports string shorthand, explicit targets,
 * and multi-cloud arrays.
 *
 * @module types/cloud-target
 */

import { CloudValidationError } from "./errors";

/** Supported cloud providers. */
export type CloudProvider = "aws" | "azure" | "gcp" | "rackspace";

/**
 * Explicit cloud target with provider and optional region.
 *
 * @example
 * ```typescript
 * const target: CloudTarget = { provider: "aws", region: "us-east-1" };
 * ```
 */
export interface CloudTarget {
  readonly provider: CloudProvider;
  /** Falls back to DEFAULT_REGIONS[provider] if omitted. */
  readonly region?: string;
}

/**
 * Flexible cloud argument accepted by all factory functions.
 *
 * - `string` shorthand: `"aws"` → reads region from config or default
 * - `CloudTarget`: explicit `{ provider, region }`
 * - `Array`: multi-cloud deployment
 *
 * @example
 * ```typescript
 * // Simple
 * cloud: "aws"
 *
 * // Explicit
 * cloud: { provider: "aws", region: "us-east-1" }
 *
 * // Multi-cloud
 * cloud: [
 *   { provider: "aws", region: "us-east-1" },
 *   { provider: "azure", region: "canadacentral" }
 * ]
 * ```
 */
export type CloudArg = CloudProvider | CloudTarget | ReadonlyArray<CloudProvider | CloudTarget>;

/**
 * Resolved cloud target — always has both provider and region.
 * Produced by resolveCloudTarget() after applying config/defaults.
 */
export interface ResolvedCloudTarget {
  readonly provider: CloudProvider;
  readonly region: string;
}

/** Default regions when none specified and no config file entry found. */
export const DEFAULT_REGIONS: Readonly<Record<CloudProvider, string>> = {
  aws: "us-east-1",
  azure: "eastus",
  gcp: "us-central1",
  rackspace: "us-central-iad3",
} as const;

/** All valid cloud providers for exhaustive checks. */
export const CLOUD_PROVIDERS: ReadonlyArray<CloudProvider> = [
  "aws",
  "azure",
  "gcp",
  "rackspace",
] as const;

/** Typed constant map for CloudProvider string literals. */
export const CLOUD_PROVIDER = {
  AWS: "aws" as const,
  AZURE: "azure" as const,
  GCP: "gcp" as const,
  RACKSPACE: "rackspace" as const,
} satisfies Record<string, CloudProvider>;

/**
 * Type guard: is the value a CloudProvider string?
 *
 * @param value - Value to check
 * @returns True if value is a valid CloudProvider
 *
 * @example
 * ```typescript
 * isCloudProvider("aws"); // true
 * isCloudProvider("digitalocean"); // false
 * ```
 */
export function isCloudProvider(value: unknown): value is CloudProvider {
  return typeof value === "string" && CLOUD_PROVIDERS.includes(value as CloudProvider);
}

/**
 * Type guard: is the value a CloudTarget object?
 *
 * @param value - Value to check
 * @returns True if value is a CloudTarget
 *
 * @example
 * ```typescript
 * isCloudTarget({ provider: "aws", region: "us-east-1" }); // true
 * isCloudTarget("aws"); // false
 * ```
 */
export function isCloudTarget(value: unknown): value is CloudTarget {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    isCloudProvider((value as CloudTarget).provider)
  );
}

/**
 * Resolve a CloudArg into one or more ResolvedCloudTargets.
 *
 * Resolution order:
 * 1. Explicit region in CloudTarget
 * 2. DEFAULT_REGIONS fallback
 *
 * @param cloud - The cloud argument to resolve
 * @returns Resolved target(s) with provider and region
 *
 * @throws {CloudValidationError} If cloud argument is invalid
 */
export function resolveCloudTarget(cloud: CloudProvider | CloudTarget): ResolvedCloudTarget;
export function resolveCloudTarget(
  cloud: ReadonlyArray<CloudProvider | CloudTarget>
): ReadonlyArray<ResolvedCloudTarget>;
export function resolveCloudTarget(
  cloud: CloudArg
): ResolvedCloudTarget | ReadonlyArray<ResolvedCloudTarget>;
export function resolveCloudTarget(
  cloud: CloudArg
): ResolvedCloudTarget | ReadonlyArray<ResolvedCloudTarget> {
  if (Array.isArray(cloud)) {
    return cloud.map((c) => resolveSingle(c));
  }
  return resolveSingle(cloud as CloudProvider | CloudTarget);
}

function resolveSingle(cloud: CloudProvider | CloudTarget): ResolvedCloudTarget {
  if (isCloudProvider(cloud)) {
    return {
      provider: cloud,
      region: DEFAULT_REGIONS[cloud],
    };
  }

  if (isCloudTarget(cloud)) {
    return {
      provider: cloud.provider,
      region: cloud.region ?? DEFAULT_REGIONS[cloud.provider],
    };
  }

  throw new CloudValidationError(
    `Invalid cloud argument: ${JSON.stringify(cloud)}. Expected CloudProvider string or CloudTarget object.`
  );
}
