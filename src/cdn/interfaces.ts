/**
 * CDN interfaces for @reyemtech/nimbus.
 *
 * @module cdn/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type { CloudArg, ResolvedCloudTarget } from "../types";

/** A hostname-specific CloudFront distribution configuration. */
export interface IEdgeDistributionConfig {
  /** Public hostname served by this distribution. */
  readonly hostname: string;
  /** HTTPS origin hostname, normally the cluster-only origin hostname. */
  readonly originDomainName: string;
  /** ACM certificate ARN for the public hostname. */
  readonly certificateArn: pulumi.Input<string>;
}

/** Configuration for the trusted-edge CloudFront distributions. */
export interface ICdnConfig {
  /** Cloud provider target. CloudFront is currently AWS-only. */
  readonly cloud: CloudArg;
  /** Header name used by the origin application to authenticate the edge. */
  readonly originSecretHeader: string;
  /** Secret injected into every distribution origin request. */
  readonly originSecretValue: pulumi.Input<string>;
  /** Header populated with the distribution's public hostname. */
  readonly clientHostHeader?: string;
  /** One distribution is created for every listed hostname. */
  readonly distributions: ReadonlyArray<IEdgeDistributionConfig>;
  /** Tags applied to every CloudFront distribution. */
  readonly tags?: Readonly<Record<string, string>>;
}

/** A provisioned trusted-edge CDN. */
export interface ICdn {
  /** Logical resource name. */
  readonly name: string;
  /** Resolved cloud target. */
  readonly cloud: ResolvedCloudTarget;
  /** CloudFront distributions keyed by hostname. */
  readonly distributions: Readonly<Record<string, pulumi.Output<string>>>;
  /** Escape hatch: the shared CloudFront origin request policy. */
  readonly nativeResource: pulumi.Resource;
}
