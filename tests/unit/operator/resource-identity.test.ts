import { describe, expect, it } from "vitest";
import {
  toCompositeIdentitySegment,
  toDnsSegment,
  toIdentitySegment,
  toLabelValue,
} from "../../../src/operator/resource-identity.js";

describe("toDnsSegment", () => {
  it("leaves a value that is already a DNS-1123 label alone", () => {
    expect(toDnsSegment("read-only-1")).toBe("read-only-1");
  });

  it("lowercases and collapses everything else to single separators", () => {
    expect(toDnsSegment("Read__Only")).toBe("read-only");
    expect(toDnsSegment("_reader_")).toBe("reader");
    expect(toDnsSegment("reporting@corp")).toBe("reporting-corp");
  });

  // This is the loss toIdentitySegment exists to repair, asserted directly so
  // the two tests cannot drift apart.
  it("maps distinct identifiers onto one value", () => {
    expect(toDnsSegment("Read_Only")).toBe(toDnsSegment("read_only"));
    expect(toDnsSegment("sales.eu")).toBe(toDnsSegment("sales_eu"));
  });
});

describe("toIdentitySegment", () => {
  // The hash is unconditional, so an ordinary name keeps a readable head and
  // gains the suffix like every other. Suffixing only the lossy names left the
  // encoded and pass-through forms sharing one output space — see the
  // "encoded form" test below for the collision that allowed.
  it.each([
    ["reader", "reader-3d094196"],
    ["etl", "etl-631fd8e1"],
    ["read-only", "read-only-4fed3970"],
  ])("keeps %s as a readable head and appends its hash", (value, expected) => {
    expect(toIdentitySegment(value)).toBe(expected);
  });

  // Two valid, simultaneously creatable PostgreSQL roles. Sharing a logical
  // name aborts the whole preview with a duplicate-URN error, so nothing is
  // provisioned — not even the resources unrelated to the clash.
  it("keeps role names apart that sanitize to the same value", () => {
    expect(toIdentitySegment("Read_Only")).not.toBe(toIdentitySegment("read_only"));
  });

  // `read-only-7b1060cf` is itself a perfectly valid role name, and it is what
  // `Read_Only` encodes to. While the hash was appended only where sanitizing
  // was lossy, this name took the pass-through path and landed on that exact
  // string — the two roles' Secrets then collided on one Pulumi logical name.
  it("keeps a raw name apart from the encoded form it is spelt like", () => {
    const encoded = toIdentitySegment("Read_Only");

    expect(encoded).toBe("read-only-7b1060cf");
    expect(toIdentitySegment(encoded)).not.toBe(encoded);
    expect(toIdentitySegment(encoded)).toBe("read-only-7b1060cf-707a9bc6");
  });

  // The property the test above is one instance of: the segment is a function
  // of the raw value, so no two distinct raw values can meet.
  it("is injective across values that sanitize, encode, or pass through alike", () => {
    const values = [
      "Read_Only",
      "read_only",
      "read-only",
      "read-only-7b1060cf",
      "READ__ONLY",
      "read.only",
    ];

    expect(new Set(values.map(toIdentitySegment)).size).toBe(values.length);
  });

  it("keeps table names apart that sanitize to the same value", () => {
    expect(toIdentitySegment("sales.eu")).not.toBe(toIdentitySegment("sales_eu"));
  });

  it("keeps the sanitized form as a readable head", () => {
    expect(toIdentitySegment("Read_Only")).toMatch(/^read-only-[0-9a-f]{8}$/);
    expect(toIdentitySegment("reporting@corp")).toMatch(/^reporting-corp-[0-9a-f]{8}$/);
  });

  // A rename is a delete-and-recreate in Pulumi, so the derived name must be a
  // pure function of the input and nothing else — not of ordering, process, or
  // any previous call.
  it("is deterministic across calls", () => {
    expect(toIdentitySegment("ledger_etl")).toBe(toIdentitySegment("ledger_etl"));
    expect(toIdentitySegment("ledger_etl")).toBe("ledger-etl-5a2ba9c8");
  });

  // Names made entirely of characters that do not survive sanitizing would
  // otherwise derive an empty segment — and every such name the same one.
  it("returns a bare hash when nothing survives sanitizing", () => {
    expect(toIdentitySegment("@@")).toMatch(/^[0-9a-f]{8}$/);
    expect(toIdentitySegment("@@")).not.toBe(toIdentitySegment("::"));
  });

  it("returns a valid DNS-1123 label for every input", () => {
    for (const value of ["Read_Only", "@@", "_x_", "sales.eu", "reader", "A".repeat(40)]) {
      expect(toIdentitySegment(value)).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    }
  });
});

describe("toCompositeIdentitySegment", () => {
  // A MariaDB account is the `username`@`host` pair: `reader`@`%` and
  // `reader`@`10.0.0.1` exist at once, with their own passwords and grants.
  it("keeps one name on two hosts apart", () => {
    expect(toCompositeIdentitySegment(["reader", "%"])).not.toBe(
      toCompositeIdentitySegment(["reader", "10.0.0.1"])
    );
  });

  it("keeps the first part as a readable head", () => {
    expect(toCompositeIdentitySegment(["reader", "10.0.0.1"])).toMatch(/^reader-[0-9a-f]{8}$/);
    expect(toCompositeIdentitySegment(["Read_Only", "%"])).toMatch(/^read-only-[0-9a-f]{8}$/);
  });

  it("is deterministic across calls", () => {
    expect(toCompositeIdentitySegment(["reader", "%"])).toBe("reader-c3d518ab");
    expect(toCompositeIdentitySegment(["reader", "%"])).toBe(
      toCompositeIdentitySegment(["reader", "%"])
    );
  });

  // The parts are serialized, not joined: a separator that appears inside a part
  // would otherwise let two different identities produce one hash input.
  it("is injective across identities whose parts share a separator", () => {
    const identities: ReadonlyArray<readonly [string, string]> = [
      ["reader", "%"],
      ["reader@%", ""],
      ["reader", "@%"],
      ["reader@", "%"],
      ["read", "er@%"],
    ];

    expect(new Set(identities.map((parts) => toCompositeIdentitySegment(parts))).size).toBe(
      identities.length
    );
  });

  it("returns a bare hash when nothing of the head survives sanitizing", () => {
    expect(toCompositeIdentitySegment(["@@", "%"])).toMatch(/^[0-9a-f]{8}$/);
    expect(toCompositeIdentitySegment(["@@", "%"])).not.toBe(
      toCompositeIdentitySegment(["@@", "10.0.0.1"])
    );
  });

  it("returns a valid DNS-1123 label for every input", () => {
    for (const value of ["Read_Only", "@@", "_x_", "reader", "A".repeat(40)]) {
      expect(toCompositeIdentitySegment([value, "%"])).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    }
  });
});

describe("toLabelValue", () => {
  // The shared role-name validator deliberately permits `@`, which is not a
  // legal label character — the Kubernetes API rejects the whole object at
  // apply time, after preview has passed.
  it("strips characters a label value may not contain", () => {
    expect(toLabelValue("reporting@corp")).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
    expect(toLabelValue("reporting@corp")).not.toContain("@");
  });

  it("keeps an ordinary role name readable in its label value", () => {
    expect(toLabelValue("reader")).toBe("reader-3d094196");
  });

  it("keeps roles apart that sanitize alike", () => {
    expect(toLabelValue("Read_Only")).not.toBe(toLabelValue("read_only"));
  });

  it("truncates to the 63-character limit the API enforces", () => {
    const value = toLabelValue(`${"role_".repeat(20)}x`);

    expect(value.length).toBeLessThanOrEqual(63);
    expect(value).toMatch(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/);
  });

  it("keeps over-long names apart after truncation", () => {
    const shared = "a".repeat(70);

    expect(toLabelValue(`${shared}1`)).not.toBe(toLabelValue(`${shared}2`));
  });
});
