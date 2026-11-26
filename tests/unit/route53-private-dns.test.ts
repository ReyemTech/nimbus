import { describe, expect, it } from "vitest";
import {
  DEFAULT_PRIVATE_DNS_PREFIX,
  externalDnsVisibilityFilter,
  route53PrivateZoneName,
} from "../../src/platform/components/route53-private-dns";

describe("Route 53 private DNS naming and selection", () => {
  it("defaults private hosted-zone prefix to internal", () => {
    expect(DEFAULT_PRIVATE_DNS_PREFIX).toBe("internal");
    expect(route53PrivateZoneName("reyem.tech")).toBe("internal.reyem.tech");
  });

  it("supports a selectable cluster prefix", () => {
    expect(route53PrivateZoneName("reyem.tech", "cac-1")).toBe("cac-1.reyem.tech");
  });

  it("rejects invalid DNS prefixes", () => {
    expect(() => route53PrivateZoneName("reyem.tech", "cac-1.reyem.tech")).toThrow(/DNS label/);
  });

  it("selects private Ingresses only for the private controller", () => {
    expect(externalDnsVisibilityFilter("nimbus.dev/dns-visibility", "private")).toBe(
      "nimbus.dev/dns-visibility=private"
    );
  });

  it("keeps unannotated Ingresses on the public controller", () => {
    expect(externalDnsVisibilityFilter("nimbus.dev/dns-visibility", "public")).toBe(
      "nimbus.dev/dns-visibility!=private"
    );
  });
});
