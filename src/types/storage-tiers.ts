/**
 * Cloud-agnostic storage tiers.
 *
 * Services declare intent (e.g. "performance"), the cluster config maps
 * it to the actual storage class name for that provider.
 *
 * @module types/storage-tiers
 */

/** Storage performance tiers — mapped to provider-specific classes per cluster. */
export type StorageTier = "standard" | "performance" | "high-performance";

/** Mapping from tier name to provider-specific storage class name. */
export type StorageTierMap = Readonly<Record<StorageTier, string>>;

/**
 * Resolve a storage tier to a concrete storage class name.
 *
 * @returns The storage class name, or undefined if tier or map is not provided.
 */
export function resolveStorageTier(
  tier: StorageTier | undefined,
  tierMap: StorageTierMap | undefined
): string | undefined {
  if (!tier || !tierMap) return undefined;
  return tierMap[tier];
}
