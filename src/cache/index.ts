/**
 * Cache module — Redis/Memcached/Valkey provisioning abstraction.
 *
 * @module cache
 */

export type { CacheEngine, CacheMode, CacheArchitecture, ICacheConfig, ICache } from "./interfaces";
export { CACHE_ENGINES, CACHE_MODES, CACHE_ARCHITECTURES } from "./interfaces";
export { createCache } from "./cache";
