/**
 * Platform module — cloud-agnostic platform stack abstraction.
 *
 * @module platform
 */

export type {
  DnsProvider,
  IPlatformComponentConfig,
  IExternalDnsConfig,
  IRoute53ExternalDnsConfig,
  IRoute53PrivateHostedZoneConfig,
  IRoute53PrivateZoneCreateConfig,
  IRoute53PrivateZoneExistingConfig,
  IHeadlampPluginId,
  IHeadlampPluginConfig,
  IHeadlampPluginsConfig,
  IHeadlampConfig,
  IVaultConfig,
  IVaultUserpassUser,
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
