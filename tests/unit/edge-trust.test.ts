/** Unit tests for framework-free trusted-edge verification. */

import { describe, expect, it } from "vitest";
import { EDGE_HEADER_PRESETS, parseEdgeClientIp, verifyEdgeHeaders } from "../../src/edge";

const config = {
  ...EDGE_HEADER_PRESETS.cloudfront,
  originSecretValue: "shared-secret",
  allowedHosts: ["www.reyem.tech", "lp.reyem.tech"],
};

describe("verifyEdgeHeaders", () => {
  it("accepts configured CloudFront headers case-insensitively", () => {
    expect(
      verifyEdgeHeaders(
        {
          "x-reyem-origin-trial": "shared-secret",
          "cloudfront-viewer-address": "203.0.113.10:443",
          "x-reyem-client-host": "LP.REYEM.TECH:443",
        },
        config
      )
    ).toEqual({ trusted: true, clientIp: "203.0.113.10", clientHost: "lp.reyem.tech" });
  });

  it("fails closed when the secret is absent, invalid, or unset", () => {
    expect(verifyEdgeHeaders({}, config)).toEqual({
      trusted: false,
      clientIp: null,
      clientHost: null,
    });
    expect(verifyEdgeHeaders({ "X-Reyem-Origin-Trial": "incorrect" }, config)).toEqual({
      trusted: false,
      clientIp: null,
      clientHost: null,
    });
    expect(
      verifyEdgeHeaders(
        { "X-Reyem-Origin-Trial": "shared-secret" },
        { ...config, originSecretValue: "" }
      )
    ).toEqual({ trusted: false, clientIp: null, clientHost: null });
  });

  it("returns no client host when a trusted hostname is absent from the allowlist", () => {
    expect(
      verifyEdgeHeaders(
        {
          "X-Reyem-Origin-Trial": "shared-secret",
          "X-Reyem-Client-Host": "attacker.example",
        },
        config
      )
    ).toEqual({ trusted: true, clientIp: null, clientHost: null });
  });

  it("treats an empty allowlist as allow-nothing", () => {
    expect(
      verifyEdgeHeaders(
        {
          "X-Reyem-Origin-Trial": "shared-secret",
          "X-Reyem-Client-Host": "www.reyem.tech",
        },
        { ...config, allowedHosts: [] }
      )
    ).toEqual({ trusted: true, clientIp: null, clientHost: null });
  });
});

describe("parseEdgeClientIp", () => {
  it("parses IPv4, bare IPv6, and bracketed IPv6 with ports", () => {
    expect(parseEdgeClientIp("203.0.113.10:443")).toBe("203.0.113.10");
    expect(parseEdgeClientIp("2001:db8::10")).toBe("2001:db8::10");
    expect(parseEdgeClientIp("[2001:db8::10]:443")).toBe("2001:db8::10");
  });

  it("rejects malformed addresses and ports", () => {
    expect(parseEdgeClientIp("203.0.113.999:443")).toBeNull();
    expect(parseEdgeClientIp("[2001:db8::10]:70000")).toBeNull();
    expect(parseEdgeClientIp("not-an-ip")).toBeNull();
  });
});
