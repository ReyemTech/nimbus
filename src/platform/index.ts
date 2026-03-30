/**
 * Platform module — cloud-agnostic platform stack abstraction.
 *
 * @module platform
 */

export type {
  DnsProvider,
  IPlatformComponentConfig,
  IExternalDnsConfig,
  IVaultConfig,
  IPlatformStackConfig,
  IPlatformStack,
} from "./interfaces";
export { DNS_PROVIDERS } from "./interfaces";

export { createPlatformStack } from "./stack";
