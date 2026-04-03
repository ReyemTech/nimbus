/**
 * Rackspace Spot cluster implementation — cloudspace + spot node pools.
 *
 * @module rackspace/cluster
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as spot from "@pulumi/spot";
import type { ICluster, IClusterConfig } from "../cluster";
import type { IRackspaceProviderOptions } from "../factories/types";
import { resolveCloudTarget } from "../types";

/**
 * Create a Rackspace Spot cloudspace with spot node pools.
 *
 * @example
 * ```typescript
 * const cluster = createRackspaceSpotCluster("prod", {
 *   cloud: "rackspace",
 *   version: "1.31",
 *   nodePools: [
 *     { name: "system", instanceType: "gp.vs1.small-2", minNodes: 2, maxNodes: 4, bidPrice: 0.02 },
 *     { name: "workers", instanceType: "gp.vs1.medium-4", minNodes: 1, maxNodes: 8, bidPrice: 0.05 },
 *   ],
 * }, { cloudspaceName: "prod-iad-1" });
 * ```
 */
export function createRackspaceSpotCluster(
  name: string,
  config: IClusterConfig,
  options: IRackspaceProviderOptions,
): ICluster {
  const cloud = Array.isArray(config.cloud) ? (config.cloud[0] ?? "rackspace") : config.cloud;
  const target = resolveCloudTarget(cloud);

  // Cloudspace
  const cloudspace = new spot.Cloudspace(
    `${name}-cloudspace`,
    {
      cloudspaceName: options.cloudspaceName,
      region: target.region,
      kubernetesVersion: config.version,
      cni: options.cni ?? "calico",
      hacontrolPlane: options.haControlPlane ?? true,
      preemptionWebhook: options.preemptionWebhookUrl,
      waitUntilReady: options.waitUntilReady ?? true,
    },
    options.importIds?.cloudspaceId
      ? { import: options.importIds.cloudspaceId }
      : undefined,
  );

  // Spot node pools
  for (const np of config.nodePools) {
    const bidPrice = np.bidPrice ?? options.defaultBidPrice;
    if (bidPrice === undefined) {
      throw new Error(
        `Node pool "${np.name}" has no bidPrice and no defaultBidPrice was set in provider options.`,
      );
    }

    const hasAutoscaling = np.minNodes !== np.maxNodes;
    const importId = options.importIds?.nodePoolIds?.[np.name];

    new spot.Spotnodepool(
      `${name}-np-${np.name}`,
      {
        cloudspaceName: cloudspace.cloudspaceName,
        serverClass: np.instanceType,
        bidPrice,
        desiredServerCount: np.desiredNodes ?? np.minNodes,
        autoscaling: hasAutoscaling
          ? { minNodes: np.minNodes, maxNodes: np.maxNodes }
          : undefined,
        labels: np.labels,
      },
      {
        dependsOn: [cloudspace],
        ...(importId ? { import: importId } : {}),
      },
    );
  }

  // Kubeconfig from data source
  const kubeconfigResult = spot.getKubeconfigOutput({
    cloudspaceName: cloudspace.cloudspaceName,
  });

  const kubeconfig = kubeconfigResult.raw;
  const endpoint = kubeconfigResult.kubeconfigs.apply((kcs) => kcs[0]!.host);

  // K8s provider
  const provider = new k8s.Provider(`${name}-k8s`, {
    kubeconfig,
  });

  return {
    name,
    cloud: target,
    endpoint,
    kubeconfig,
    version: cloudspace.kubernetesVersion,
    nodePools: config.nodePools,
    nativeResource: cloudspace,
    provider,
    storageTiers: config.storageTiers,
  };
}
