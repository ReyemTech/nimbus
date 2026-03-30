/**
 * Shared types, interfaces, and constants for @reyemtech/nimbus.
 *
 * @module types
 */

export {
  type CloudProvider,
  type CloudTarget,
  type CloudArg,
  type ResolvedCloudTarget,
  DEFAULT_REGIONS,
  CLOUD_PROVIDERS,
  isCloudProvider,
  isCloudTarget,
  resolveCloudTarget,
} from "./cloud-target";

export {
  type ErrorCode,
  ERROR_CODES,
  AnyCloudError,
  CloudValidationError,
  CidrError,
  UnsupportedFeatureError,
  ConfigError,
  assertNever,
} from "./errors";

export { type IRequiredTags, normalizeTags, isValidGcpLabel, mergeWithRequiredTags } from "./tags";

export {
  type IValidationResult,
  validateFeature,
  isFeatureSupported,
  validateMultiCloud,
  validateResourceName,
  assertValidMultiCloud,
} from "./validation";

export { type StorageTier, type StorageTierMap, STORAGE_TIERS, resolveStorageTier } from "./storage-tiers";
