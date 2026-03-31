/**
 * Access gateway module — provider-agnostic remote cluster access.
 *
 * Supports Tailscale (always-on mesh) and WireGuard (self-hosted VPN).
 * Optional split DNS for multi-cluster service discovery.
 *
 * @module access
 */

import type { IAccessGatewayConfig, IAccessGateway } from "./interfaces";
import { deployTailscale } from "./tailscale";
import { deployWireGuard } from "./wireguard";
import { assertNever } from "../types";

export type {
  AccessGatewayProvider,
  IAccessDnsConfig,
  ITailscaleConfig,
  IWireGuardPeer,
  IWireGuardConfig,
  ITailscaleGatewayConfig,
  IWireGuardGatewayConfig,
  IAccessGatewayConfig,
  IAccessGateway,
} from "./interfaces";
export { ACCESS_GATEWAY_PROVIDERS } from "./interfaces";

/**
 * Create an access gateway for secure remote access to cluster services.
 *
 * @example
 * ```typescript
 * const gateway = createAccessGateway("vpn", {
 *   cluster,
 *   hostnamePrefix: "iad-1",
 *   dns: { enabled: true, tld: "internal" },
 *   provider: "tailscale",
 *   tailscale: {
 *     authKey: config.requireSecret("tailscaleAuthKey"),
 *     routes: ["10.0.0.0/8"],
 *   },
 * });
 * ```
 */
export function createAccessGateway(
  name: string,
  config: IAccessGatewayConfig
): IAccessGateway {
  switch (config.provider) {
    case "tailscale":
      return deployTailscale(name, config);
    case "wireguard":
      return deployWireGuard(name, config);
    default:
      return assertNever(config);
  }
}
