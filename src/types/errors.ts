/**
 * Custom error classes for @reyemtech/nimbus.
 *
 * All errors extend AnyCloudError with a machine-readable code.
 * Use discriminated error codes for programmatic handling.
 *
 * @module types/errors
 */

/** Error codes for all nimbus errors. */
export const ERROR_CODES = {
  CLOUD_VALIDATION: "CLOUD_VALIDATION",
  CIDR_OVERLAP: "CIDR_OVERLAP",
  CIDR_INVALID: "CIDR_INVALID",
  UNSUPPORTED_FEATURE: "UNSUPPORTED_FEATURE",
  CONFIG_MISSING: "CONFIG_MISSING",
  CONFIG_INVALID: "CONFIG_INVALID",
  SECRET_NOT_FOUND: "SECRET_NOT_FOUND",
  PROVIDER_MISMATCH: "PROVIDER_MISMATCH",
  INVALID_GRANT: "INVALID_GRANT",
  UNSUPPORTED_PRIVILEGE: "UNSUPPORTED_PRIVILEGE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/**
 * Base error for all nimbus errors.
 *
 * @example
 * ```typescript
 * try {
 *   createCluster("prod", { cloud: "invalid" as any });
 * } catch (e) {
 *   if (e instanceof AnyCloudError) {
 *     console.log(e.code); // "CLOUD_VALIDATION"
 *   }
 * }
 * ```
 */
export class AnyCloudError extends Error {
  readonly code: ErrorCode;

  constructor(message: string, code: ErrorCode) {
    super(message);
    this.name = "AnyCloudError";
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a cloud provider or region is invalid.
 *
 * @throws When an unsupported provider string is passed, or a required
 *   region is missing and cannot be resolved from config/defaults.
 */
export class CloudValidationError extends AnyCloudError {
  constructor(message: string) {
    super(message, ERROR_CODES.CLOUD_VALIDATION);
    this.name = "CloudValidationError";
  }
}

/**
 * Thrown when CIDR ranges overlap or are invalid.
 *
 * @throws When multi-cloud CIDRs would conflict (preventing peering/mesh),
 *   or when a CIDR string cannot be parsed.
 */
export class CidrError extends AnyCloudError {
  readonly cidrs?: ReadonlyArray<string>;

  constructor(
    message: string,
    code: "CIDR_OVERLAP" | "CIDR_INVALID",
    cidrs?: ReadonlyArray<string>
  ) {
    super(message, code);
    this.name = "CidrError";
    this.cidrs = cidrs;
  }
}

/**
 * Thrown when a feature is not supported for a given cloud provider.
 *
 * @throws When requesting a feature that doesn't exist on the target
 *   cloud (e.g., EKS Auto Mode on Azure).
 */
export class UnsupportedFeatureError extends AnyCloudError {
  readonly feature: string;
  readonly provider: string;

  constructor(feature: string, provider: string) {
    super(
      `Feature "${feature}" is not supported on provider "${provider}".`,
      ERROR_CODES.UNSUPPORTED_FEATURE
    );
    this.name = "UnsupportedFeatureError";
    this.feature = feature;
    this.provider = provider;
  }
}

/**
 * Thrown when Pulumi config is missing or malformed.
 *
 * @throws When a required config value is not set in Pulumi.<stack>.yaml
 *   or when the config value has an unexpected shape.
 */
export class ConfigError extends AnyCloudError {
  readonly configKey?: string;

  constructor(message: string, code: "CONFIG_MISSING" | "CONFIG_INVALID", configKey?: string) {
    super(message, code);
    this.name = "ConfigError";
    this.configKey = configKey;
  }
}

/**
 * Helper for exhaustive switch/case. Ensures all cases are handled at compile time.
 *
 * @param value - The value that should have been handled by a prior case
 * @throws Always throws — reaching this function means a case was missed
 *
 * @example
 * ```typescript
 * switch (provider) {
 *   case "aws": return createEks(...);
 *   case "azure": return createAks(...);
 *   case "gcp": return createGke(...);
 *   default: assertNever(provider);
 * }
 * ```
 */
export function assertNever(value: never): never {
  throw new UnsupportedFeatureError(`Unhandled value: ${JSON.stringify(value)}`, String(value));
}
