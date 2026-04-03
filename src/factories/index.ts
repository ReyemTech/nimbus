/**
 * Factory functions — the primary cloud-agnostic API.
 *
 * Use these instead of cloud-specific functions (createAwsNetwork, createEksCluster, etc.)
 * for truly cloud-agnostic infrastructure code.
 *
 * @module factories
 */

export type { IProviderOptions, IAwsProviderOptions, IAzureProviderOptions, IRackspaceProviderOptions } from "./types";
export { extractProvider, isMultiCloud } from "./types";

export { createNetwork, type ICreateNetworkConfig } from "./network";
export { createCluster, type ICreateClusterConfig } from "./cluster";
export { createDns, type ICreateDnsConfig } from "./dns";
export { createSecrets, type ICreateSecretsConfig } from "./secrets";
export { createStateBackend, type ICreateStateBackendConfig } from "./state";
