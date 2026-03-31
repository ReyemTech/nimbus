/**
 * Access gateway interfaces for @reyemtech/nimbus.
 *
 * Provider-agnostic remote access to Kubernetes cluster services
 * via Tailscale, WireGuard, or future providers.
 *
 * @module access/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type * as k8s from "@pulumi/kubernetes";
import type { ICluster } from "../cluster";

/** Access gateway provider type. */
export type AccessGatewayProvider = "tailscale" | "wireguard";

/** Typed constant map for AccessGatewayProvider string literals. */
export const ACCESS_GATEWAY_PROVIDERS = {
  TAILSCALE: "tailscale" as const,
  WIREGUARD: "wireguard" as const,
} satisfies Record<string, AccessGatewayProvider>;

/** Split DNS configuration for service discovery. */
export interface IAccessDnsConfig {
  /** Enable split DNS for service discovery. Default: false. */
  readonly enabled: boolean;
  /** Top-level domain for service names. Default: "internal". */
  readonly tld?: string;
}

/** Tailscale-specific configuration. */
export interface ITailscaleConfig {
  /** OAuth client ID (generate at Tailscale admin → Settings → OAuth). */
  readonly oauthClientId: pulumi.Input<string>;
  /** OAuth client secret. */
  readonly oauthClientSecret: pulumi.Input<string>;
  /** Subnet routes to advertise to the tailnet (e.g., ["10.0.0.0/8"]). */
  readonly routes: ReadonlyArray<string>;
  /** Tags for the operator node (e.g., ["tag:k8s"]). Default: ["tag:k8s"]. */
  readonly tags?: ReadonlyArray<string>;
  /** Tailscale Operator Helm chart version override. */
  readonly version?: string;
  /** Additional Helm values. */
  readonly values?: Readonly<Record<string, unknown>>;
}

/** WireGuard peer (client) configuration. */
export interface IWireGuardPeer {
  /** Peer display name (used for config file naming). */
  readonly name: string;
  /** Peer's WireGuard public key. */
  readonly publicKey: string;
  /** IP addresses assigned to this peer within the VPN CIDR. */
  readonly allowedIps: ReadonlyArray<string>;
}

/** WireGuard-specific configuration. */
export interface IWireGuardConfig {
  /** Public DNS name or IP for the WireGuard endpoint. */
  readonly endpoint: string;
  /** UDP listen port. Default: 51820. */
  readonly listenPort?: number;
  /** VPN tunnel CIDR (e.g., "10.100.0.0/24"). */
  readonly serverCidr: string;
  /** Subnet routes to push to clients (e.g., ["10.0.0.0/8"]). */
  readonly routes: ReadonlyArray<string>;
  /** Client peers. */
  readonly peers: ReadonlyArray<IWireGuardPeer>;
  /** WireGuard Helm chart version override. */
  readonly version?: string;
  /** Additional Helm values. */
  readonly values?: Readonly<Record<string, unknown>>;
}

/** Tailscale access gateway config. */
export interface ITailscaleGatewayConfig {
  readonly cluster: ICluster;
  readonly hostnamePrefix?: string;
  readonly dns?: IAccessDnsConfig;
  readonly provider: "tailscale";
  readonly tailscale: ITailscaleConfig;
}

/** WireGuard access gateway config. */
export interface IWireGuardGatewayConfig {
  readonly cluster: ICluster;
  readonly hostnamePrefix?: string;
  readonly dns?: IAccessDnsConfig;
  readonly provider: "wireguard";
  readonly wireguard: IWireGuardConfig;
}

/** Access gateway config — discriminated union on provider. */
export type IAccessGatewayConfig =
  | ITailscaleGatewayConfig
  | IWireGuardGatewayConfig;

/** Access gateway output. */
export interface IAccessGateway {
  readonly name: string;
  readonly provider: AccessGatewayProvider;
  readonly namespace: string;
  readonly helmRelease: k8s.helm.v3.Release;
  readonly serverPublicKey?: pulumi.Output<string>;
  readonly clientConfigs?: pulumi.Output<Record<string, string>>;
}
