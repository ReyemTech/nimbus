/**
 * Cluster factory — creates EKS/AKS via a single cloud-agnostic function.
 *
 * Dispatches to AWS or Azure based on the `cloud` parameter.
 * For multi-cloud arrays, matches networks by provider and returns an array.
 *
 * @module factories/cluster
 */

import type { ICluster, IClusterConfig } from "../cluster";
import type { INetwork } from "../network";
import { resolveCloudTarget, UnsupportedFeatureError } from "../types";
import type { ResolvedCloudTarget } from "../types";
import type { IProviderOptions } from "./types";
import { isMultiCloud } from "./types";
import { createEksCluster } from "../aws/index.js";
import { createAksCluster } from "../azure/index.js";
import { createRackspaceSpotCluster } from "../rackspace/index.js";

/** Config for the createCluster factory. */
export type ICreateClusterConfig = IClusterConfig & {
  readonly providerOptions?: IProviderOptions;
};

/**
 * Create a Kubernetes cluster (EKS/AKS) for one or more cloud providers.
 *
 * @param name - Resource name prefix
 * @param config - Cluster configuration with cloud target and optional providerOptions
 * @param networks - Network(s) to deploy into. For multi-cloud, pass an array matched by provider.
 * @returns Single ICluster for a single cloud target, array for multi-cloud
 * @throws {UnsupportedFeatureError} If the cloud provider is not supported, Azure options are missing, or no matching network is found
 *
 * @example
 * ```typescript
 * // Single cloud
 * const cluster = createCluster("prod", {
 *   cloud: "aws",
 *   nodePools: [{ name: "system", instanceType: "t4g.small", minNodes: 2, maxNodes: 3 }],
 *   providerOptions: { aws: { autoMode: true } },
 * }, network);
 *
 * // Multi-cloud
 * const clusters = createCluster("prod", {
 *   cloud: ["aws", "azure"],
 *   nodePools: [...],
 *   providerOptions: {
 *     aws: { autoMode: true },
 *     azure: { resourceGroupName: "my-rg" },
 *   },
 * }, networks);
 * ```
 */
export function createCluster(
  name: string,
  config: ICreateClusterConfig,
  networks?: INetwork | INetwork[]
): ICluster | ICluster[] {
  if (!isMultiCloud(config.cloud)) {
    const target = resolveCloudTarget(config.cloud);

    // Rackspace doesn't use a network — dispatch directly
    if (target.provider === "rackspace") {
      const rackOpts = config.providerOptions?.rackspace;
      if (!rackOpts) {
        throw new UnsupportedFeatureError(
          "Rackspace requires providerOptions.rackspace with at least cloudspaceName",
          "rackspace"
        );
      }
      return createRackspaceSpotCluster(
        name,
        { ...config, cloud: { provider: target.provider, region: target.region } },
        rackOpts
      );
    }

    // All other providers require a network
    if (!networks) {
      throw new UnsupportedFeatureError(
        `Provider "${target.provider}" clusters require a network parameter`,
        target.provider
      );
    }
    const network = Array.isArray(networks) ? findNetworkForProvider(networks, target) : networks;
    return dispatchCluster(name, config, target, network, config.providerOptions);
  }

  const targets = resolveCloudTarget(config.cloud);
  if (!networks) {
    throw new UnsupportedFeatureError(
      "Multi-cloud clusters require a networks parameter",
      "multi-cloud"
    );
  }
  const networkArray = Array.isArray(networks) ? networks : [networks];

  return targets.map((target) => {
    const network = findNetworkForProvider(networkArray, target);
    return dispatchCluster(
      `${name}-${target.provider}`,
      config,
      target,
      network,
      config.providerOptions
    );
  });
}

function dispatchCluster(
  name: string,
  config: IClusterConfig,
  target: ResolvedCloudTarget,
  network: INetwork,
  opts?: IProviderOptions
): ICluster {
  const targetConfig = { ...config, cloud: { provider: target.provider, region: target.region } };

  switch (target.provider) {
    case "aws": {
      return createEksCluster(name, targetConfig, network, opts?.aws);
    }
    case "azure": {
      const azureOpts = opts?.azure;
      if (!azureOpts) {
        throw new UnsupportedFeatureError(
          "Azure requires providerOptions.azure.resourceGroupName",
          "azure"
        );
      }
      return createAksCluster(name, targetConfig, network, {
        resourceGroupName: azureOpts.resourceGroupName,
        azureCni: azureOpts.azureCni,
        virtualNodes: azureOpts.virtualNodes,
        aadTenantId: azureOpts.aadTenantId,
        dnsPrefix: azureOpts.dnsPrefix,
      });
    }
    default:
      throw new UnsupportedFeatureError("cluster", target.provider);
  }
}

/**
 * Find a network matching the target provider from an array of networks.
 */
function findNetworkForProvider(
  networks: ReadonlyArray<INetwork>,
  target: ResolvedCloudTarget
): INetwork {
  const match = networks.find((n) => n.cloud.provider === target.provider);
  if (!match) {
    throw new UnsupportedFeatureError(
      `No network found for provider "${target.provider}". ` +
        `Available: ${networks.map((n) => n.cloud.provider).join(", ")}`,
      target.provider
    );
  }
  return match;
}
