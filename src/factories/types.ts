/**
 * Factory types for cloud-agnostic resource creation.
 *
 * Defines provider-specific options that can be passed through
 * the unified factory functions via the `providerOptions` field.
 *
 * @module factories/types
 */

import type * as pulumi from "@pulumi/pulumi";
import type { IEksMetricsServerOptions } from "../aws/cluster";
import type { CloudArg, CloudProvider, CloudTarget } from "../types";

/** AWS-specific options passed through factory functions. */
export interface IAwsProviderOptions {
  /** fck-nat instance type. Default: "t4g.nano". */
  readonly fckNatInstanceType?: string;
  /** Number of AZs to use. Default: 2. */
  readonly availabilityZoneCount?: number;
  /** Enable EKS Auto Mode. Default: false. */
  readonly autoMode?: boolean;
  /** EKS add-ons to install. Default: vpc-cni, coredns, kube-proxy. */
  readonly addons?: ReadonlyArray<string>;
  /** Endpoint access: "public", "private", or "both". Default: "both". */
  readonly endpointAccess?: "public" | "private" | "both";
  /** CIDRs allowed to reach the public Kubernetes API endpoint. */
  readonly publicAccessCidrs?: ReadonlyArray<string>;
  /** IAM role or user principal ARN to grant cluster-admin through an EKS access entry. */
  readonly clusterAdminRoleArn?: pulumi.Input<string>;
  /** Kubernetes provider's `aws eks get-token` role to assume. */
  readonly kubernetesProviderRoleArn?: pulumi.Input<string>;
  /** Encrypted gp3 root volume configuration for EKS managed node groups. */
  readonly nodeGroupRootDisk?: {
    readonly sizeGiB?: number;
    readonly deleteOnTermination?: boolean;
  };
  /** Install EBS CSI plus Pod Identity permissions. */
  readonly ebsCsiDriver?: boolean;
  /** EKS API authentication mode. Defaults to API_AND_CONFIG_MAP. */
  readonly authenticationMode?: "API" | "API_AND_CONFIG_MAP" | "CONFIG_MAP";
  /** Whether the cluster creator gets bootstrap administrator access. */
  readonly bootstrapClusterCreatorAdminPermissions?: boolean;
  /** EKS version support policy; omitted preserves the AWS default. */
  readonly upgradePolicy?: { readonly supportType: "STANDARD" | "EXTENDED" };
  /** Tags applied to EC2 instances in managed node groups. */
  readonly nodeGroupInstanceTags?: Readonly<Record<string, string>>;
  /** Managed node-group AMI family, e.g. AL2023_ARM_64_STANDARD. */
  readonly nodeGroupAmiType?: pulumi.Input<string>;
  /** Opt in to the EKS community Metrics Server add-on. */
  readonly metricsServer?: boolean | IEksMetricsServerOptions;
  /** KMS key ARN for state backend encryption. Uses AES256 if not provided. */
  readonly stateKmsKeyArn?: string;
  /** Allow Pulumi to destroy the state bucket (for dev/test). Default: false. */
  readonly stateForceDestroy?: boolean;
}

/** Azure-specific options passed through factory functions. */
export interface IAzureProviderOptions {
  /** Resource group name. Required for Azure. */
  readonly resourceGroupName: pulumi.Input<string>;
  /** Number of subnet pairs. Default: 2. */
  readonly subnetCount?: number;
  /** Enable Azure CNI networking. Default: true. */
  readonly azureCni?: boolean;
  /** Enable virtual node (ACI). Default: false. */
  readonly virtualNodes?: boolean;
  /** Azure AD tenant ID for RBAC integration. */
  readonly aadTenantId?: string;
  /** DNS prefix for the cluster FQDN. Default: cluster name. */
  readonly dnsPrefix?: string;
  /** Azure AD tenant ID for Key Vault. Required for secrets. */
  readonly tenantId?: pulumi.Input<string>;
  /** Object ID for Key Vault access. */
  readonly objectId?: pulumi.Input<string>;
  /** Key Vault SKU. Default: "standard". */
  readonly sku?: "standard" | "premium";
}

/** Rackspace Spot-specific options passed through factory functions. */
export interface IRackspaceProviderOptions {
  /** Cluster connection mode. Defaults to `managed` for backward compatibility. */
  readonly mode?: "managed" | "existing-cluster";
  /** Connect Kubernetes resources with a supplied kubeconfig instead of Rackspace's kubeconfig. */
  readonly kubeconfig?: pulumi.Input<string>;
  /** Select a named context from the supplied kubeconfig. Defaults to its current-context. */
  readonly kubeconfigContext?: pulumi.Input<string>;
  /** Use pod ServiceAccount credentials instead of either kubeconfig. */
  readonly useInClusterConfig?: boolean;
  /** Cloudspace name in the Rackspace Spot platform. Required. */
  readonly cloudspaceName?: string;
  /** CNI plugin. Default: "calico". */
  readonly cni?: "calico" | "cilium" | "byocni";
  /** HA control plane. Default: true. */
  readonly haControlPlane?: boolean;
  /** Preemption webhook URL (e.g., Slack webhook). */
  readonly preemptionWebhookUrl?: string;
  /** Wait for cloudspace to be ready. Default: true. */
  readonly waitUntilReady?: boolean;
  /** Default bid price (USD) for spot node pools that don't specify their own. */
  readonly defaultBidPrice?: number;
  /** Pulumi import IDs for adopting existing resources. */
  readonly importIds?: {
    readonly cloudspaceId?: string;
    readonly nodePoolIds?: Record<string, string>;
  };
  /** Aliases for the K8s provider resource (for migrating from a manual provider). */
  readonly k8sProviderAliases?: ReadonlyArray<string | { name?: string; parent?: unknown }>;
}

/**
 * Provider-specific options keyed by cloud provider.
 *
 * Used in factory functions to pass cloud-specific configuration
 * without changing the unified API surface.
 *
 * @example
 * ```typescript
 * createNetwork("prod", {
 *   cloud: "azure",
 *   cidr: "10.1.0.0/16",
 *   providerOptions: {
 *     azure: { resourceGroupName: "my-rg" },
 *   },
 * });
 * ```
 */
export interface IProviderOptions {
  readonly aws?: IAwsProviderOptions;
  readonly azure?: IAzureProviderOptions;
  readonly rackspace?: IRackspaceProviderOptions;
}

/**
 * Extract the provider string from a CloudArg for single-target dispatch.
 * For arrays, returns the first element's provider.
 *
 * @param cloud - A cloud provider string or CloudTarget object
 * @returns The cloud provider identifier
 *
 * @example
 * ```typescript
 * extractProvider("aws"); // "aws"
 * extractProvider({ provider: "azure", region: "eastus" }); // "azure"
 * ```
 */
export function extractProvider(cloud: CloudProvider | CloudTarget): CloudProvider {
  if (typeof cloud === "string") return cloud;
  return cloud.provider;
}

/**
 * Check if a CloudArg is a multi-cloud array.
 *
 * @param cloud - The cloud argument to check
 * @returns True if the argument is an array of cloud targets
 *
 * @example
 * ```typescript
 * isMultiCloud("aws"); // false
 * isMultiCloud(["aws", "azure"]); // true
 * ```
 */
export function isMultiCloud(cloud: CloudArg): cloud is ReadonlyArray<CloudProvider | CloudTarget> {
  return Array.isArray(cloud);
}
