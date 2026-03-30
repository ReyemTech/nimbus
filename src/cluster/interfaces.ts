/**
 * Cluster interfaces for @reyemtech/nimbus.
 *
 * Abstracts Kubernetes cluster provisioning across EKS, AKS, and GKE.
 * Supports EKS Auto Mode, AKS virtual nodes, spot instances, and
 * multiple node pool configurations.
 *
 * @module cluster/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type * as k8s from "@pulumi/kubernetes";
import type { CloudArg, ResolvedCloudTarget } from "../types";
import type { StorageTierMap } from "../types/storage-tiers";

/** Kubernetes node taint. */
export interface INodeTaint {
  /** Taint key (e.g., "dedicated"). */
  readonly key: string;
  /** Taint value (e.g., "gpu"). */
  readonly value: string;
  /** Taint effect controlling pod scheduling behavior. */
  readonly effect: "NoSchedule" | "PreferNoSchedule" | "NoExecute";
}

/**
 * Node pool configuration.
 *
 * @example
 * ```typescript
 * const pool: INodePool = {
 *   name: "workers",
 *   instanceType: "c6a.large",
 *   minNodes: 2,
 *   maxNodes: 8,
 *   spot: true,
 *   labels: { "workload-type": "general" },
 * };
 * ```
 */
export interface INodePool {
  /** Node pool name (e.g., "workers", "system"). */
  readonly name: string;
  /** Compute instance type (e.g., "c6a.large", "Standard_D2s_v3"). */
  readonly instanceType: string;
  /** Minimum number of nodes for autoscaling. */
  readonly minNodes: number;
  /** Maximum number of nodes for autoscaling. */
  readonly maxNodes: number;
  /** Desired initial node count. Defaults to minNodes if omitted. */
  readonly desiredNodes?: number;
  /** Use spot/preemptible instances for cost savings. */
  readonly spot?: boolean;
  /** Kubernetes labels applied to nodes in this pool. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Kubernetes taints applied to nodes in this pool. */
  readonly taints?: ReadonlyArray<INodeTaint>;
  /** Node pool mode (AKS concept: "system" vs "user"). Maps to labels on other providers. */
  readonly mode?: "system" | "user";
}

/**
 * Cluster configuration input.
 *
 * @example
 * ```typescript
 * const config: IClusterConfig = {
 *   cloud: "aws",
 *   version: "1.32",
 *   nodePools: [
 *     { name: "system", instanceType: "t3.medium", minNodes: 2, maxNodes: 4 },
 *     { name: "workers", instanceType: "c6a.large", minNodes: 2, maxNodes: 8, spot: true },
 *   ],
 * };
 * ```
 */
export interface IClusterConfig {
  /** Cloud provider target or multi-cloud array. */
  readonly cloud: CloudArg;
  /** Kubernetes version (e.g., "1.32"). Uses provider default if omitted. */
  readonly version?: string;
  /** Node pool definitions for the cluster. */
  readonly nodePools: ReadonlyArray<INodePool>;
  /** EKS Auto Mode: no explicit node groups, AWS manages node selection. */
  readonly autoMode?: boolean;
  /** AKS: enable Azure Container Instances virtual node. */
  readonly virtualNodes?: boolean;
  /** Optional: attach to an existing network. */
  readonly networkId?: pulumi.Input<string>;
  /** Resource tags applied to the cluster and child resources. */
  readonly tags?: Readonly<Record<string, string>>;
}

/**
 * Cluster output — the created Kubernetes cluster resource.
 *
 * Provides a unified interface regardless of the underlying cloud provider.
 * Use `nativeResource` for cloud-specific operations via escape hatch.
 */
export interface ICluster {
  /** Logical name of the cluster resource. */
  readonly name: string;
  /** Resolved cloud target this cluster was provisioned on. */
  readonly cloud: ResolvedCloudTarget;
  /** Kubernetes API server endpoint URL. */
  readonly endpoint: pulumi.Output<string>;
  /** Kubeconfig for authenticating with the cluster. */
  readonly kubeconfig: pulumi.Output<string>;
  /** Kubernetes version running on the cluster. */
  readonly version: pulumi.Output<string>;
  /** Node pool configurations attached to this cluster. */
  readonly nodePools: ReadonlyArray<INodePool>;

  /**
   * Escape hatch: access the cloud-native cluster resource.
   *
   * @example
   * ```typescript
   * const eksCluster = cluster.nativeResource as aws.eks.Cluster;
   * eksCluster.arn.apply(arn => console.log("EKS ARN:", arn));
   * ```
   */
  readonly nativeResource: pulumi.Resource;

  /** Pulumi K8s provider for deploying workloads to this cluster. */
  readonly provider: k8s.Provider;

  /**
   * Mapping from storage tiers to provider-specific storage class names.
   * When set, modules use resolveStorageTier() to select the correct class.
   */
  readonly storageTiers?: StorageTierMap;
}

/** AWS-specific cluster extensions for EKS. */
export interface IEksClusterExtensions {
  /** Discriminant identifying this as AWS. */
  readonly provider: "aws";
  /** Whether EKS Auto Mode is enabled. */
  readonly autoMode?: boolean;
}

/** Azure-specific cluster extensions for AKS. */
export interface IAksClusterExtensions {
  /** Discriminant identifying this as Azure. */
  readonly provider: "azure";
  /** Whether AKS virtual nodes (ACI) are enabled. */
  readonly virtualNodes?: boolean;
  /** Whether Azure CNI networking is enabled. */
  readonly azureCni?: boolean;
}

/** GCP-specific cluster extensions for GKE. */
export interface IGkeClusterExtensions {
  /** Discriminant identifying this as GCP. */
  readonly provider: "gcp";
  /** Whether GKE Autopilot mode is enabled. */
  readonly autopilot?: boolean;
}

/**
 * Discriminated union of provider-specific cluster extensions.
 * Use `provider` field to narrow the type in a switch/case.
 */
export type ProviderClusterExtensions =
  | IEksClusterExtensions
  | IAksClusterExtensions
  | IGkeClusterExtensions;
