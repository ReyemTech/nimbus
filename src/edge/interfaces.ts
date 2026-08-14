/**
 * Framework-free trusted-edge interfaces.
 *
 * @module edge/interfaces
 */

/** Headers received by an application from its HTTP framework. */
export type EdgeHeaders = Readonly<Record<string, string | ReadonlyArray<string> | undefined>>;

/** Supported edge vendor header defaults. */
export type EdgeProvider = "cloudfront" | "azureFrontDoor";

/** Configurable header names supplied by an edge provider. */
export interface IEdgeHeaderNames {
  /** Header containing the shared origin secret. */
  readonly originSecretHeader: string;
  /** Header containing the viewer's IP address and port. */
  readonly clientIpHeader: string;
  /** Header containing the static hostname configured for this distribution. */
  readonly clientHostHeader: string;
}

/** Edge origin verification configuration. */
export interface IEdgeTrustConfig extends IEdgeHeaderNames {
  /** Shared origin secret. An absent or empty value makes every request untrusted. */
  readonly originSecretValue?: string;
  /** Hostnames permitted to be carried by the configured client-host header. */
  readonly allowedHosts: ReadonlyArray<string>;
}

/** Result of verifying edge-provided request headers. */
export interface IEdgeTrustVerdict {
  /** Whether the origin secret was present and matched. */
  readonly trusted: boolean;
  /** Verified client IP address, without its optional port. */
  readonly clientIp: string | null;
  /** Verified, allowlisted client hostname. */
  readonly clientHost: string | null;
}
