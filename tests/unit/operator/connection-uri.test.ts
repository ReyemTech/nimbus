import { describe, expect, it } from "vitest";
import { encodeUriComponentValue } from "../../../src/operator/connection-uri.js";

describe("encodeUriComponentValue", () => {
  // The role-name validator rejects only what would break a database identifier
  // (backtick, quotes, backslash, NUL), so URI delimiters reach this layer and
  // must not survive into the composed URI as structure.
  it.each([
    ["@", "reporting@corp", "reporting%40corp"],
    [":", "reader:ro", "reader%3Aro"],
    ["/", "team/reader", "team%2Freader"],
    ["?", "reader?x", "reader%3Fx"],
    ["#", "reader#1", "reader%231"],
  ])("encodes %s, which is a URI delimiter", (_char, raw, expected) => {
    expect(encodeUriComponentValue(raw)).toBe(expected);
  });

  it("leaves an ordinary role name untouched", () => {
    expect(encodeUriComponentValue("kimai-readonly")).toBe("kimai-readonly");
  });

  // Generated passwords are base64url, whose alphabet is already URI-safe. They
  // are encoded anyway, so this pins that encoding them is a no-op rather than a
  // corruption.
  it("passes a base64url password through unchanged", () => {
    expect(encodeUriComponentValue("aB9-_xYz")).toBe("aB9-_xYz");
  });

  // A raw "@" would end the userinfo early, so a parser would read the host from
  // the middle of the role name. Encoded, the URI parses back to what was meant.
  it("round-trips through a URL parser", () => {
    const uri = `postgresql://${encodeUriComponentValue("reporting@corp")}:${encodeUriComponentValue(
      "p:w@rd"
    )}@db.svc:5432/${encodeUriComponentValue("an/alytics")}`;
    const parsed = new URL(uri);

    expect(decodeURIComponent(parsed.username)).toBe("reporting@corp");
    expect(decodeURIComponent(parsed.password)).toBe("p:w@rd");
    expect(parsed.hostname).toBe("db.svc");
    expect(parsed.port).toBe("5432");
    expect(decodeURIComponent(parsed.pathname)).toBe("/an/alytics");
  });
});
