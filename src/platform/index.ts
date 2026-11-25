/**
 * Platform module — cloud-agnostic platform stack abstraction.
 *
 * @module platform
 */

export type {
  DnsProvider,
  IPlatformComponentConfig,
  IExternalDnsConfig,
  IHeadlampPluginId,
  IHeadlampPluginConfig,
  IHeadlampPluginsConfig,
  IHeadlampConfig,
  IVaultConfig,
  IAutoUnsealConfig,
  IAwsKmsUnsealConfig,
  IAzureKeyVaultUnsealConfig,
  IGcpCkmsUnsealConfig,
  IPlatformStackConfig,
  ITrivyExposureClassifierConfig,
  IPlatformStack,
} from "./interfaces";
export { DNS_PROVIDERS } from "./interfaces";

export { createPlatformStack } from "./stack";
