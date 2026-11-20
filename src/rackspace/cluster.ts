/**
 * Rackspace Spot cluster implementation — native Pulumi provider.
 *
 * Uses @reyemtech/pulumi-rackspace-spot which calls the Rackspace Spot
 * K8s API directly. CloudSpace is a managed resource with proper diff
 * (only mutable fields trigger updates). No more TF bridge bugs.
 *
 * @module rackspace/cluster
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import * as spot from "@reyemtech/pulumi-rackspace-spot";
import { parse as parseYaml } from "yaml";
import type { ICluster, IClusterConfig } from "../cluster";
import type { IRackspaceProviderOptions } from "../factories/types";
import { resolveCloudTarget } from "../types";

/**
 * Create a Rackspace Spot cluster via the native Pulumi provider.
 *
 * Manages cloudspace and node pools as proper Pulumi resources with
 * correct diff behavior. Kubeconfig is fetched fresh on every deployment.
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
  options: IRackspaceProviderOptions
): ICluster {
  const cloud = Array.isArray(config.cloud) ? (config.cloud[0] ?? "rackspace") : config.cloud;
  const target = resolveCloudTarget(cloud);
  if (options.kubeconfig !== undefined && options.useInClusterConfig) {
    throw new Error('Set either "kubeconfig" or "useInClusterConfig", not both.');
  }
  if (options.kubeconfigContext !== undefined && options.kubeconfig === undefined) {
    throw new Error('"kubeconfigContext" requires a supplied "kubeconfig".');
  }

  // Existing-cluster mode owns only its Kubernetes provider. It deliberately
  // returns before any Rackspace Spot data source or resource is registered.
  if (options.mode === "existing-cluster") {
    const provider = new k8s.Provider(
      `${name}-k8s`,
      {
        ...(options.kubeconfig === undefined ? {} : { kubeconfig: options.kubeconfig }),
        ...(options.kubeconfigContext === undefined ? {} : { context: options.kubeconfigContext }),
      },
      options.k8sProviderAliases?.length
        ? { aliases: options.k8sProviderAliases as pulumi.Alias[] }
        : undefined
    );
    const endpoint = endpointFromKubeconfig(options.kubeconfig, options.kubeconfigContext);
    return {
      name,
      cloud: target,
      endpoint,
      kubeconfig: pulumi.output(options.kubeconfig ?? ""),
      version: pulumi.output(config.version ?? "unknown"),
      nodePools: config.nodePools,
      nativeResource: provider as unknown as pulumi.Resource,
      provider,
      storageTiers: config.storageTiers,
    };
  }

  if (!options.cloudspaceName) {
    throw new Error('Rackspace managed mode requires "cloudspaceName".');
  }

  // CloudSpace — read via data source. The native provider's CloudSpace resource
  // has a protobuf serialization issue during import (toJavaScript error).
  // TODO: Switch to managed resource when import is fixed.
  const cloudspace = spot.getCloudspaceOutput({
    name: options.cloudspaceName,
  });

  // Spot node pools
  for (const np of config.nodePools) {
    const bidPrice = np.bidPrice ?? options.defaultBidPrice;
    if (bidPrice === undefined) {
      throw new Error(
        `Node pool "${np.name}" has no bidPrice and no defaultBidPrice was set in provider options.`
      );
    }

    const hasAutoscaling = np.minNodes !== np.maxNodes;
    const importId = options.importIds?.nodePoolIds?.[np.name];

    new spot.SpotNodePool(
      `${name}-np-${np.name}`,
      {
        cloudspaceName: options.cloudspaceName,
        serverClass: np.instanceType,
        bidPrice,
        desiredCount: np.desiredNodes ?? np.minNodes,
        autoscaling: hasAutoscaling ? { minNodes: np.minNodes, maxNodes: np.maxNodes } : undefined,
        labels: np.labels,
      },
      importId ? { import: importId } : undefined
    );
  }

  // Keep Rackspace resources registered while allowing Kubernetes workloads
  // to switch credentials after cluster creation.
  const useRackspaceKubeconfig = options.kubeconfig === undefined && !options.useInClusterConfig;
  const kubeconfigResult = useRackspaceKubeconfig
    ? spot.getKubeconfigOutput({ cloudspaceName: options.cloudspaceName })
    : undefined;
  const kubeconfig = options.kubeconfig ?? kubeconfigResult?.raw ?? "";
  const endpoint =
    kubeconfigResult?.host ?? endpointFromKubeconfig(options.kubeconfig, options.kubeconfigContext);

  // K8s provider
  const provider = new k8s.Provider(
    `${name}-k8s`,
    options.useInClusterConfig
      ? {}
      : {
          kubeconfig,
          ...(options.kubeconfigContext === undefined
            ? {}
            : { context: options.kubeconfigContext }),
        },
    options.k8sProviderAliases?.length
      ? { aliases: options.k8sProviderAliases as pulumi.Alias[] }
      : undefined
  );

  return {
    name,
    cloud: target,
    endpoint,
    kubeconfig: pulumi.output(kubeconfig),
    version: cloudspace.kubernetesVersion.apply((v) => v ?? config.version ?? "unknown"),
    nodePools: config.nodePools,
    nativeResource: provider as unknown as pulumi.Resource,
    provider,
    storageTiers: config.storageTiers,
  };
}

function endpointFromKubeconfig(
  kubeconfig: pulumi.Input<string> | undefined,
  contextOverride?: pulumi.Input<string>
): pulumi.Output<string> {
  if (kubeconfig === undefined) return pulumi.output("");
  return pulumi.all([kubeconfig, contextOverride ?? ""]).apply(([raw, override]) => {
    try {
      const parsed = parseYaml(raw) as {
        "current-context"?: string;
        contexts?: Array<{ name?: string; context?: { cluster?: string } }>;
        clusters?: Array<{ name?: string; cluster?: { server?: string } }>;
      } | null;
      const contextName = override || parsed?.["current-context"];
      const clusterName = parsed?.contexts?.find((item) => item.name === contextName)?.context
        ?.cluster;
      const selectedCluster = parsed?.clusters?.find((item) => item.name === clusterName);
      if (selectedCluster?.cluster?.server) return selectedCluster.cluster.server;
      return parsed?.clusters?.length === 1 ? (parsed.clusters[0]?.cluster?.server ?? "") : "";
    } catch {
      return "";
    }
  });
}
