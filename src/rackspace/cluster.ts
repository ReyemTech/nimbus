/**
 * Rackspace Spot cluster implementation — reads existing cloudspace, manages node pools.
 *
 * The cloudspace is treated as a data source (read-only) because the Rackspace Spot
 * Terraform provider sends ALL fields on update, and the Rackspace API webhook rejects
 * updates containing immutable fields. Node pools are managed resources that can be
 * imported and updated normally.
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
 * Create a Rackspace Spot cluster (reads cloudspace, manages node pools).
 *
 * The cloudspace must already exist — this function reads it via data source.
 * Node pools are created/managed as Pulumi resources and can be imported.
 *
 * @example
 * ```typescript
 * const cluster = createRackspaceSpotCluster("iad-1", {
 *   cloud: { provider: "rackspace", region: "us-east-iad-1" },
 *   version: "1.33.0",
 *   nodePools: [
 *     { name: "workers", instanceType: "gp.vs1.xlarge-iad", minNodes: 3, maxNodes: 3, spot: true, bidPrice: 0.04 },
 *   ],
 * }, { cloudspaceName: "reyemtech2" });
 * ```
 */
export function createRackspaceSpotCluster(
  name: string,
  config: IClusterConfig,
  options: IRackspaceProviderOptions,
): ICluster {
  const cloud = Array.isArray(config.cloud) ? (config.cloud[0] ?? "rackspace") : config.cloud;
  const target = resolveCloudTarget(cloud);

  // Read existing cloudspace (data source — no mutations)
  const cloudspace = spot.getCloudspaceOutput({
    cloudspaceName: options.cloudspaceName,
  });

  // Spot node pools (managed resources)
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
        cloudspaceName: options.cloudspaceName,
        serverClass: np.instanceType,
        bidPrice,
        desiredServerCount: np.desiredNodes ?? np.minNodes,
        autoscaling: hasAutoscaling
          ? { minNodes: np.minNodes, maxNodes: np.maxNodes }
          : undefined,
        labels: np.labels,
      },
      importId ? { import: importId } : undefined,
    );
  }

  // Kubeconfig from data source (fresh on every deployment)
  const kubeconfigResult = spot.getKubeconfigOutput({
    cloudspaceName: options.cloudspaceName,
  });

  const kubeconfig = kubeconfigResult.raw;
  const endpoint = kubeconfigResult.kubeconfigs.apply((kcs) => kcs[0]!.host);

  // K8s provider
  const provider = new k8s.Provider(`${name}-k8s`, {
    kubeconfig,
  }, options.k8sProviderAliases?.length
    ? { aliases: options.k8sProviderAliases as pulumi.Alias[] }
    : undefined,
  );

  return {
    name,
    cloud: target,
    endpoint,
    kubeconfig,
    version: cloudspace.kubernetesVersion.apply((v) => v ?? config.version ?? "unknown"),
    nodePools: config.nodePools,
    nativeResource: provider as unknown as pulumi.Resource,
    provider,
    storageTiers: config.storageTiers,
  };
}
