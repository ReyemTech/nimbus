/**
 * Network interfaces for @reyemtech/nimbus.
 *
 * Abstracts VPC (AWS), VNet (Azure), and VPC (GCP) provisioning.
 * Includes NAT strategy options (managed, fck-nat, none) and
 * CIDR overlap detection for multi-cloud deployments.
 *
 * @module network/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type { CloudArg, ResolvedCloudTarget } from "../types";

/** NAT gateway strategy. */
export type NatStrategy =
  | "managed" // Cloud-native NAT Gateway (AWS: ~$32/mo, Azure: ~$32/mo)
  | "fck-nat" // fck-nat instance on AWS (~$3/mo) — AWS only
  | "none"; // No NAT (public subnets only or hosted K8s)

/** Typed constant map for NatStrategy string literals. */
export const NAT_STRATEGIES = {
  MANAGED: "managed" as const,
  FCK_NAT: "fck-nat" as const,
  NONE: "none" as const,
} satisfies Record<string, NatStrategy>;

/** Subnet configuration. */
export interface ISubnetConfig {
  /** CIDR block for the subnet (e.g., "10.0.1.0/24"). */
  readonly cidr: string;
  /** Availability zone placement (e.g., "us-east-1a"). */
  readonly availabilityZone?: string;
  /** Whether this subnet has a public IP and internet gateway route. */
  readonly public?: boolean;
}

/**
 * Network configuration input.
 *
 * @example
 * ```typescript
 * const config: INetworkConfig = {
 *   cloud: "aws",
 *   cidr: "10.0.0.0/16",
 *   natStrategy: "fck-nat", // ~$97/mo savings vs managed NAT
 * };
 * ```
 */
export interface INetworkConfig {
  /** Cloud provider target or multi-cloud array. */
  readonly cloud: CloudArg;
  /** CIDR block for the VPC/VNet. Optional for hosted K8s without custom networking (e.g. Rackspace Spot). */
  readonly cidr?: string;
  /** Public subnet definitions. Auto-generated if omitted. */
  readonly publicSubnets?: ReadonlyArray<ISubnetConfig>;
  /** Private subnet definitions. Auto-generated if omitted. */
  readonly privateSubnets?: ReadonlyArray<ISubnetConfig>;
  /** NAT gateway strategy. Default: "managed". */
  readonly natStrategy?: NatStrategy;
  /** Enable DNS hostnames in the VPC (AWS-specific). */
  readonly enableDnsHostnames?: boolean;
  /** Enable DNS support in the VPC (AWS-specific). */
  readonly enableDnsSupport?: boolean;
  /** Resource tags applied to the network and child resources. */
  readonly tags?: Readonly<Record<string, string>>;
}

/**
 * Network output — the created VPC/VNet resource.
 *
 * Use `nativeResource` for cloud-specific network operations.
 */
export interface INetwork {
  /** Logical name of the network resource. */
  readonly name: string;
  /** Resolved cloud target this network was provisioned on. */
  readonly cloud: ResolvedCloudTarget;
  /** VPC ID (AWS), VNet ID (Azure), or Network self-link (GCP). */
  readonly vpcId: pulumi.Output<string>;
  /** CIDR block assigned to this network. */
  readonly cidr?: string;
  /** IDs of public subnets created within the network. */
  readonly publicSubnetIds: pulumi.Output<ReadonlyArray<string>>;
  /** IDs of private subnets created within the network. */
  readonly privateSubnetIds: pulumi.Output<ReadonlyArray<string>>;
  /** NAT gateway ID, if a NAT strategy was applied. */
  readonly natGatewayId?: pulumi.Output<string>;

  /** Escape hatch: cloud-native network resource. */
  readonly nativeResource: pulumi.Resource;
}
