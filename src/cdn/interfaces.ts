/**
 * CDN interfaces for @reyemtech/nimbus.
 *
 * @module cdn/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type { CloudArg, ResolvedCloudTarget } from "../types";

export type CloudFrontAllowedMethod =
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "PUT"
  | "POST"
  | "PATCH"
  | "DELETE";
export type CloudFrontCachedMethod = "GET" | "HEAD" | "OPTIONS";
export type CloudFrontViewerProtocolPolicy = "allow-all" | "https-only" | "redirect-to-https";

/** Shared private Application Load Balancer origin managed by CloudFront VPC Origins. */
export interface IEdgeVpcAlbOriginConfig {
  readonly type: "alb-vpc";
  /** ARN of an existing internal Application Load Balancer. */
  readonly albArn: pulumi.Input<string>;
  /** CloudFront-to-ALB protocol. Defaults to HTTPS only. */
  readonly originProtocolPolicy?: "http-only" | "https-only" | "match-viewer";
  /** Port used for HTTP when the protocol policy permits HTTP. Defaults to 80. */
  readonly httpPort?: number;
  /** Port used for HTTPS when the protocol policy permits HTTPS. Defaults to 443. */
  readonly httpsPort?: number;
  /** Optional explicit ALB security-group ingress port. Defaults to the origin listener port(s). */
  readonly securityGroupPort?: number;
  /** ALB security groups to update. Required if the ALB has more than one attached security group. */
  readonly albSecurityGroupIds?: ReadonlyArray<pulumi.Input<string>>;
}

/** An ordered CloudFront behavior for a path with distinct cache semantics. */
export interface IEdgeOrderedCacheBehavior {
  /** CloudFront path pattern, for example `/booking-confirmed*`. */
  readonly pathPattern: string;
  /** Cache policy ID, including an AWS managed policy or an IaC-created custom policy. */
  readonly cachePolicyId?: pulumi.Input<string>;
  /** Optional origin request policy ID. Defaults to the distribution's policy. */
  readonly originRequestPolicyId?: pulumi.Input<string>;
  /** Optional allowed viewer methods. Defaults to the distribution's methods. */
  readonly allowedMethods?: ReadonlyArray<CloudFrontAllowedMethod>;
  /** Optional methods CloudFront may cache. Defaults to the distribution's methods. */
  readonly cachedMethods?: ReadonlyArray<CloudFrontCachedMethod>;
  /** Optional viewer protocol policy. Defaults to the distribution's policy. */
  readonly viewerProtocolPolicy?: CloudFrontViewerProtocolPolicy;
}

/** A hostname-specific CloudFront distribution configuration. */
export interface IEdgeDistributionConfig {
  /** Public hostname served by this distribution. */
  readonly hostname: string;
  /** HTTPS public custom-origin hostname, normally the cluster-only origin hostname. */
  readonly originDomainName?: string;
  /** ACM certificate ARN for the public hostname. */
  readonly certificateArn: pulumi.Input<string>;
  /** Additional CloudFront aliases served by this distribution. */
  readonly aliases?: ReadonlyArray<string>;
  /** Optional default cache policy. Defaults vary by origin type. */
  readonly cachePolicyId?: pulumi.Input<string>;
  /** Optional default origin request policy. Defaults vary by origin type. */
  readonly originRequestPolicyId?: pulumi.Input<string>;
  /** Optional allowed viewer methods. */
  readonly allowedMethods?: ReadonlyArray<CloudFrontAllowedMethod>;
  /** Optional methods CloudFront may cache. */
  readonly cachedMethods?: ReadonlyArray<CloudFrontCachedMethod>;
  /** Optional viewer protocol policy. */
  readonly viewerProtocolPolicy?: CloudFrontViewerProtocolPolicy;
  /** Path-specific CloudFront behaviors evaluated before the default behavior. */
  readonly orderedCacheBehaviors?: ReadonlyArray<IEdgeOrderedCacheBehavior>;
}

/** Configuration for the trusted-edge CloudFront distributions. */
export interface ICdnConfig {
  /** Cloud provider target. CloudFront is currently AWS-only. */
  readonly cloud: CloudArg;
  /** Route 53 public hosted zone ID for the distribution aliases. */
  readonly hostedZoneId: pulumi.Input<string>;
  /** Optional global WAF web ACL ARN associated with every distribution. */
  readonly webAclArn?: pulumi.Input<string>;
  /** Header name used by the origin application to authenticate the edge. */
  readonly originSecretHeader: string;
  /** Secret injected into every distribution origin request. */
  readonly originSecretValue: pulumi.Input<string>;
  /** Optional shared private ALB VPC Origin used by every distribution. */
  readonly vpcOrigin?: IEdgeVpcAlbOriginConfig;
  /** Header populated with the distribution's public hostname. */
  readonly clientHostHeader?: string;
  /** One distribution is created for every listed hostname. */
  readonly distributions: ReadonlyArray<IEdgeDistributionConfig>;
  /** Tags applied to every CloudFront distribution. */
  readonly tags?: Readonly<Record<string, string>>;
}

/** Route 53 alias records for one public CloudFront hostname. */
export interface IEdgeAliasRecords {
  /** IPv4 Route 53 alias record FQDN. */
  readonly a: pulumi.Output<string>;
  /** IPv6 Route 53 alias record FQDN. */
  readonly aaaa: pulumi.Output<string>;
}

/** A provisioned trusted-edge CDN. */
export interface ICdn {
  /** Logical resource name. */
  readonly name: string;
  /** Resolved cloud target. */
  readonly cloud: ResolvedCloudTarget;
  /** CloudFront distributions keyed by every primary and alias hostname. */
  readonly distributions: Readonly<Record<string, pulumi.Output<string>>>;
  /** Route 53 public aliases keyed by hostname. */
  readonly aliases: Readonly<Record<string, IEdgeAliasRecords>>;
  /** Escape hatch: the shared CloudFront origin request policy. */
  readonly nativeResource: pulumi.Resource;
}
