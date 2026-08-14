/**
 * Framework-free verification for headers supplied by a trusted application edge.
 *
 * @module edge/verify
 */

import { isIP } from "node:net";
import type {
  EdgeHeaders,
  EdgeProvider,
  IEdgeHeaderNames,
  IEdgeTrustConfig,
  IEdgeTrustVerdict,
} from "./interfaces";

/** Named header defaults for supported edge providers. */
export const EDGE_HEADER_PRESETS: Readonly<Record<EdgeProvider, IEdgeHeaderNames>> = {
  cloudfront: {
    originSecretHeader: "X-Reyem-Origin-Trial",
    clientIpHeader: "CloudFront-Viewer-Address",
    clientHostHeader: "X-Reyem-Client-Host",
  },
  azureFrontDoor: {
    originSecretHeader: "X-Reyem-Origin-Trial",
    clientIpHeader: "X-Azure-ClientIP",
    clientHostHeader: "X-Reyem-Client-Host",
  },
};

/** A supported edge provider's default header names. */
export type EdgeHeaderPreset = (typeof EDGE_HEADER_PRESETS)[EdgeProvider];

/**
 * Verify edge-provided request headers without depending on a web framework.
 *
 * An untrusted request deliberately returns no edge-derived value. A trusted request receives a
 * client hostname only when it appears in the explicit allowlist; an empty allowlist allows none.
 */
export function verifyEdgeHeaders(
  headers: EdgeHeaders,
  config: IEdgeTrustConfig
): IEdgeTrustVerdict {
  const originSecret = readHeader(headers, config.originSecretHeader);
  if (
    !config.originSecretValue ||
    !originSecret ||
    !timingSafeEqual(originSecret, config.originSecretValue)
  ) {
    return { trusted: false, clientIp: null, clientHost: null };
  }

  const clientIp = parseEdgeClientIp(readHeader(headers, config.clientIpHeader));
  const clientHost = normalizeHost(readHeader(headers, config.clientHostHeader));
  const allowedHosts = new Set(
    config.allowedHosts.map((host) => normalizeHost(host)).filter(isPresent)
  );

  return {
    trusted: true,
    clientIp,
    clientHost: clientHost && allowedHosts.has(clientHost) ? clientHost : null,
  };
}

/**
 * Parse the client address emitted by an edge, accepting `IP:port` and bracketed IPv6 values.
 */
export function parseEdgeClientIp(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const address = value.trim();
  const bracketedIpv6 = /^\[([^\]]+)](?::(\d{1,5}))?$/.exec(address);
  if (bracketedIpv6) {
    return isValidPort(bracketedIpv6[2]) && isIP(bracketedIpv6[1] ?? "") === 6
      ? (bracketedIpv6[1] ?? null)
      : null;
  }

  if (isIP(address)) {
    return address;
  }

  const addressWithPort = /^(.*):(\d{1,5})$/.exec(address);
  if (!addressWithPort || !isValidPort(addressWithPort[2])) {
    return null;
  }

  const ip = addressWithPort[1] ?? "";
  return isIP(ip) ? ip : null;
}

function readHeader(headers: EdgeHeaders, name: string): string | null {
  const expected = name.toLowerCase();
  for (const [headerName, value] of Object.entries(headers)) {
    if (headerName.toLowerCase() === expected && typeof value === "string") {
      return value;
    }
  }
  return null;
}

function normalizeHost(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const host = value.trim().toLowerCase();
  if (!host || host.startsWith("[")) {
    return null;
  }

  const lastColon = host.lastIndexOf(":");
  return lastColon === -1 || host.indexOf(":") !== lastColon ? host : host.slice(0, lastColon);
}

function timingSafeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);

  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return difference === 0;
}

function isValidPort(value: string | undefined): boolean {
  return value === undefined || (Number(value) >= 0 && Number(value) <= 65535);
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}
