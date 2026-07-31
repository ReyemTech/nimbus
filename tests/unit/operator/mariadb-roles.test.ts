import { describe, expect, it } from "vitest";
import {
  OWNER_GRANT,
  additionalRoleNaming,
  ownerRoleNaming,
  toMariadbGrants,
  type IMariadbRoleNaming,
} from "../../../src/operator/mariadb-roles.js";
import { AnyCloudError, ERROR_CODES } from "../../../src/types/errors.js";

// Pulumi identifies a resource by its logical name. Changing one of these
// strings makes Pulumi delete and recreate the resource — for a credential
// Secret that regenerates the password and breaks every running application
// that reads it. These assertions pin the names extracted from mariadb.ts when
// role provisioning was factored out; a failure here is a release blocker, not
// a test to update.
describe("ownerRoleNaming", () => {
  const naming = ownerRoleNaming("shared-maria", "analytics");

  it.each([
    ["credentialResource", naming.credentialResource, "shared-maria-analytics-password-secret"],
    ["credentialSecret", naming.credentialSecret, "shared-maria-analytics-user"],
    ["userResource", naming.userResource, "shared-maria-analytics-user"],
    ["userMetadataName", naming.userMetadataName, "shared-maria-analytics"],
    ["connectionResourcePrefix", naming.connectionResourcePrefix, "shared-maria-analytics-secret"],
    ["connectionSecret", naming.connectionSecret, "shared-maria-analytics-mariadb"],
  ])("pins %s to its pre-refactor value", (_field, actual, expected) => {
    expect(actual).toBe(expected);
  });

  // The owner holds exactly one grant, and its pre-existing names carry no
  // suffix — so the table must not leak into either name.
  it("pins the owner's single grant to its unsuffixed names", () => {
    expect(naming.grantNaming("*").resource).toBe("shared-maria-analytics-grant");
    expect(naming.grantNaming("*").metadataName).toBe("shared-maria-analytics");
  });

  // `metadata.name` was never sanitized for the owner. Sanitizing it now would
  // orphan the live Database/User/Grant objects and create fresh ones.
  it("leaves the owner's metadata name unsanitized", () => {
    expect(ownerRoleNaming("Shared_Maria", "An_Alytics").userMetadataName).toBe(
      "Shared_Maria-An_Alytics"
    );
  });
});

/** The subset of names Pulumi uses to identify resources. */
const pulumiNames = (naming: IMariadbRoleNaming): string[] => [
  naming.credentialResource,
  naming.userResource,
  naming.connectionResourcePrefix,
  naming.grantNaming("*").resource,
];

/** The subset of names Kubernetes objects are created under. */
const kubernetesNames = (naming: IMariadbRoleNaming): string[] => [
  naming.credentialSecret,
  naming.userMetadataName,
  naming.connectionSecret,
  naming.grantNaming("*").metadataName,
];

describe("additionalRoleNaming", () => {
  it("prefixes every name with the role", () => {
    const role = additionalRoleNaming("shared-maria", "analytics", "reader", "%");

    expect(role.credentialResource).toBe("shared-maria-analytics-role-reader-c3d518ab-secret");
    expect(role.credentialSecret).toBe("shared-maria-analytics-role-reader-c3d518ab");
    expect(role.userResource).toBe("shared-maria-analytics-role-reader-c3d518ab-user");
    expect(role.userMetadataName).toBe("shared-maria-analytics-role-reader-c3d518ab");
    expect(role.connectionResourcePrefix).toBe(
      "shared-maria-analytics-role-reader-c3d518ab-connection"
    );
    expect(role.connectionSecret).toBe("shared-maria-analytics-role-reader-c3d518ab-mariadb");
  });

  // Keying grants on the table rather than on their position is what makes
  // reordering a role's `grants` array a no-op. A positional name would rewrite
  // `spec.table` on live Grant CRs — a field the operator's webhook may refuse,
  // turning a harmless reorder into a permanently failing apply.
  it("names each grant for the table it covers, not its position", () => {
    const role = additionalRoleNaming("shared-maria", "analytics", "reader", "%");

    expect(role.grantNaming("events").resource).toBe(
      "shared-maria-analytics-role-reader-c3d518ab-grant-events-862417b9"
    );
    expect(role.grantNaming("events").metadataName).toBe(
      "shared-maria-analytics-role-reader-c3d518ab-grant-events-862417b9"
    );
  });

  it("renders the whole-database table as `all`", () => {
    const role = additionalRoleNaming("shared-maria", "analytics", "reader", "%");

    expect(role.grantNaming("*").resource).toBe(
      "shared-maria-analytics-role-reader-c3d518ab-grant-all"
    );
  });

  it("sanitizes table names that are not valid DNS-1123 labels", () => {
    const role = additionalRoleNaming("c", "d", "reader", "%");

    expect(role.grantNaming("Order_Items").resource).toBe(
      "c-d-role-reader-c3d518ab-grant-order-items-62753264"
    );
  });

  // `sales.eu` and `sales_eu` are two distinct tables MariaDB will hold at once,
  // and both sanitize to `sales-eu`. toMariadbGrants merges grants by the RAW
  // table, so both survive as separate Grant CRs — which then registered under
  // one Pulumi logical name and aborted the preview with a duplicate URN.
  it("keeps table names apart that sanitize to the same value", () => {
    const role = additionalRoleNaming("c", "d", "reader", "%");

    expect(role.grantNaming("sales.eu").resource).not.toBe(role.grantNaming("sales_eu").resource);
    expect(role.grantNaming("sales.eu").metadataName).not.toBe(
      role.grantNaming("sales_eu").metadataName
    );
  });

  // A table name that is already a valid DNS-1123 label carries the hash too:
  // a table could otherwise be named after another table's encoded form and the
  // two Grant CRs would register under one Pulumi logical name.
  it("suffixes a table name that needs no sanitizing too", () => {
    const role = additionalRoleNaming("c", "d", "reader", "%");

    expect(role.grantNaming("events").resource).toBe(
      "c-d-role-reader-c3d518ab-grant-events-862417b9"
    );
    expect(role.grantNaming("sales-eu-d6cd8bd8").resource).not.toBe(
      role.grantNaming("sales.eu").resource
    );
  });

  // Grant names must be a function of the table alone: stable for one table, so
  // reordering a role's `grants` array is a no-op rather than a rename that
  // deletes and recreates every Grant CR — and distinct across tables, since two
  // tables sharing a logical name is a duplicate-URN error at preview. Comparing
  // `grantNaming(t)` against itself would assert neither; both halves are
  // asserted against fixed expected values instead.
  it("derives a stable name from the table alone", () => {
    const role = additionalRoleNaming("c", "d", "reader", "%");

    expect(role.grantNaming("events").resource).toBe(
      "c-d-role-reader-c3d518ab-grant-events-862417b9"
    );
    expect(role.grantNaming("events").metadataName).toBe(
      "c-d-role-reader-c3d518ab-grant-events-862417b9"
    );
  });

  it("gives different tables different names", () => {
    const role = additionalRoleNaming("c", "d", "reader", "%");
    const tables = ["events", "orders", "Order_Items", "*", "invoices", "sales.eu", "sales_eu"];

    const names = tables.map((table) => role.grantNaming(table).resource);

    expect(new Set(names).size).toBe(tables.length);
    expect(names).toEqual([
      "c-d-role-reader-c3d518ab-grant-events-862417b9",
      "c-d-role-reader-c3d518ab-grant-orders-1c168adb",
      "c-d-role-reader-c3d518ab-grant-order-items-62753264",
      "c-d-role-reader-c3d518ab-grant-all",
      "c-d-role-reader-c3d518ab-grant-invoices-491dabd4",
      "c-d-role-reader-c3d518ab-grant-sales-eu-d6cd8bd8",
      "c-d-role-reader-c3d518ab-grant-sales-eu-0abb0838",
    ]);
  });

  // A role literally named "user", "grant", or "secret" is the case most likely
  // to land on one of the owner's stems. Names are only compared within their
  // own identifier space — a Pulumi logical name and a Kubernetes object name
  // may coincide harmlessly, since nothing resolves one against the other.
  it.each(["user", "grant", "secret", "password", "mariadb", "role"])(
    "does not collide with the owner's names for a role named %s",
    (roleName) => {
      const owner = ownerRoleNaming("c", "d");
      const role = additionalRoleNaming("c", "d", roleName, "%");

      for (const value of pulumiNames(owner)) {
        expect(pulumiNames(role)).not.toContain(value);
      }
      for (const value of kubernetesNames(owner)) {
        expect(kubernetesNames(role)).not.toContain(value);
      }
    }
  );

  it("sanitizes role names that are not valid DNS-1123 labels", () => {
    const role = additionalRoleNaming("c", "d", "Read_Only", "%");

    expect(role.credentialSecret).toBe("c-d-role-read-only-dfba3b40");
    expect(role.userMetadataName).toBe("c-d-role-read-only-dfba3b40");
  });

  // `Read_Only` and `read_only` are two distinct accounts MariaDB will happily
  // hold at once, and sanitizing maps both to `read-only`. Two resources under
  // one Pulumi logical name is a duplicate-URN error that aborts the whole
  // preview — nothing is provisioned, including everything unrelated to the
  // clash — so the sanitized form is disambiguated by a hash of the raw name.
  it("keeps role names apart that sanitize to the same value", () => {
    const upper = additionalRoleNaming("c", "d", "Read_Only", "%");
    const lower = additionalRoleNaming("c", "d", "read_only", "%");

    expect(upper.credentialResource).not.toBe(lower.credentialResource);
    expect(upper.userResource).not.toBe(lower.userResource);
    expect(upper.connectionResourcePrefix).not.toBe(lower.connectionResourcePrefix);
    expect(upper.grantNaming("*").resource).not.toBe(lower.grantNaming("*").resource);
  });

  // A user may legitimately be named after another user's *encoded* form —
  // `read-only-dfba3b40` needs no sanitizing and is a valid MariaDB username.
  // Suffixing only the lossy names let it pass through onto the exact string
  // `Read_Only` encodes to, which is the duplicate URN the hash exists to
  // prevent. Every segment carries the hash, so the two namespaces are disjoint.
  it("keeps a user named after another user's encoded form apart from it", () => {
    const encoded = additionalRoleNaming("c", "d", "Read_Only", "%");
    const literal = additionalRoleNaming("c", "d", "read-only-dfba3b40", "%");

    expect(encoded.credentialSecret).toBe("c-d-role-read-only-dfba3b40");
    expect(literal.credentialSecret).toBe("c-d-role-read-only-dfba3b40-d07cd2ca");
    expect(literal.credentialResource).not.toBe(encoded.credentialResource);
    expect(literal.userResource).not.toBe(encoded.userResource);
  });

  // The registry deliberately permits one username on two hosts, because MariaDB
  // holds those as two accounts with their own passwords and grants. Deriving
  // names from the username alone registered the second account under the
  // first's logical names — a duplicate URN that aborts the preview, so the
  // account the registry had just allowed could never be created.
  it("keeps one username on two hosts apart", () => {
    const anywhere = additionalRoleNaming("c", "d", "reader", "%");
    const internal = additionalRoleNaming("c", "d", "reader", "10.0.0.1");

    expect(anywhere.credentialResource).not.toBe(internal.credentialResource);
    expect(anywhere.credentialSecret).not.toBe(internal.credentialSecret);
    expect(anywhere.userResource).not.toBe(internal.userResource);
    expect(anywhere.userMetadataName).not.toBe(internal.userMetadataName);
    expect(anywhere.connectionResourcePrefix).not.toBe(internal.connectionResourcePrefix);
    expect(anywhere.connectionSecret).not.toBe(internal.connectionSecret);
    expect(anywhere.grantNaming("*").resource).not.toBe(internal.grantNaming("*").resource);
    expect(anywhere.grantNaming("*").metadataName).not.toBe(internal.grantNaming("*").metadataName);
  });

  // Hosts are folded into the hash rather than joined onto the name, so two
  // identities cannot serialize alike however the parts are spelt.
  it("gives every distinct user@host pair a distinct name", () => {
    const identities: ReadonlyArray<readonly [string, string]> = [
      ["reader", "%"],
      ["reader", "10.0.0.1"],
      ["reader", "10.0.0.2"],
      ["reader@10.0.0.1", "%"],
      ["reader", "%@10.0.0.1"],
      ["Reader", "%"],
    ];

    const names = identities.map(
      ([roleName, host]) => additionalRoleNaming("c", "d", roleName, host).credentialSecret
    );

    expect(new Set(names).size).toBe(identities.length);
  });

  // The head stays readable: a human still finds `reader`'s Secret by name, the
  // host being what the hash disambiguates.
  it("keeps the username as the readable head", () => {
    expect(additionalRoleNaming("c", "d", "reader", "10.0.0.1").credentialSecret).toMatch(
      /^c-d-role-reader-[0-9a-f]{8}$/
    );
  });

  // Instance, database, role and table names are all caller-controlled and
  // unbounded, and Kubernetes rejects a `metadata.name` over 253 characters at
  // apply time — after preview has passed, so the CRs the account needs are
  // never created. Nothing here names a Job, so the stricter 63-character label
  // limit does not apply.
  describe("with a long instance, database and role", () => {
    const clusterName = `production-mariadb-instance-${"x".repeat(90)}`;
    const dbName = `customer-analytics-warehouse-${"y".repeat(90)}`;
    const roleName = `reporting-read-only-service-account-${"z".repeat(90)}`;
    const naming = additionalRoleNaming(clusterName, dbName, roleName, "%");
    const longTable = `orders-${"w".repeat(90)}`;

    it("bounds every name to the DNS-1123 subdomain limit", () => {
      const names = [
        ...pulumiNames(naming),
        ...kubernetesNames(naming),
        naming.grantNaming(longTable).resource,
        naming.grantNaming(longTable).metadataName,
      ];

      for (const name of names) {
        expect(name.length).toBeLessThanOrEqual(253);
      }
    });

    // Truncating each name independently must not merge two of them: two
    // resources under one Pulumi logical name abort the preview with a
    // duplicate URN. The credential Secret and the User CR share a name by
    // design — they are different object kinds — so the assertion is that
    // truncation introduces no coincidence a short name does not already have.
    it("keeps every truncated name distinct within its own space", () => {
      const short = additionalRoleNaming("c", "d", "reader", "%");

      expect(new Set(pulumiNames(naming)).size).toBe(pulumiNames(naming).length);
      expect(new Set(kubernetesNames(naming)).size).toBe(new Set(kubernetesNames(short)).size);
    });

    // Two tables whose names truncate alike are still two Grant CRs.
    it("keeps two long tables apart after truncation", () => {
      expect(naming.grantNaming(`${longTable}-a`).resource).not.toBe(
        naming.grantNaming(`${longTable}-b`).resource
      );
    });

    it("keeps two roles apart whose names truncate alike", () => {
      const first = additionalRoleNaming(clusterName, dbName, `${roleName}-a`, "%");
      const second = additionalRoleNaming(clusterName, dbName, `${roleName}-b`, "%");

      expect(first.credentialSecret).not.toBe(second.credentialSecret);
      expect(first.userMetadataName).not.toBe(second.userMetadataName);
    });
  });

  // A name needing no sanitizing still carries the hash: the rule has no
  // exceptions, which is what makes the mapping injective by construction.
  it("suffixes a name that needs no sanitizing too", () => {
    expect(additionalRoleNaming("c", "d", "read-only", "%").credentialSecret).toBe(
      "c-d-role-read-only-2f080e17"
    );
  });
});

describe("toMariadbGrants", () => {
  // Privileges come back sorted, not in the order supplied: that is what makes
  // a reordered config produce byte-identical output and no Pulumi diff.
  it("upper-cases privileges as MariaDB spells them", () => {
    expect(toMariadbGrants([{ privileges: ["select", "Insert"] }])).toEqual([
      { privileges: ["INSERT", "SELECT"], table: "*", grantOption: false },
    ]);
  });

  it.each([
    [undefined, "*"],
    ["all", "*"],
    ["events", "events"],
  ])("maps objects %s to table %s", (objects, table) => {
    const [grant] = toMariadbGrants([{ privileges: ["SELECT"], objects }]);

    expect(grant?.table).toBe(table);
  });

  // MariaDB has no schema concept distinct from the database, so a schema-scoped
  // grant must degrade to a database-wide one rather than emitting an invalid CR.
  it("drops schema, which MariaDB cannot express", () => {
    expect(toMariadbGrants([{ privileges: ["SELECT"], schema: "marts" }])).toEqual([
      { privileges: ["SELECT"], table: "*", grantOption: false },
    ]);
  });

  it("never sets grantOption for a non-owner role", () => {
    const grants = toMariadbGrants([{ privileges: ["SELECT"] }, { privileges: ["INSERT"] }]);

    expect(grants.every((grant) => grant.grantOption === false)).toBe(true);
  });

  it("preserves order so grant indices stay stable across deploys", () => {
    const grants = toMariadbGrants([
      { privileges: ["SELECT"], objects: "a" },
      { privileges: ["INSERT"], objects: "b" },
    ]);

    expect(grants.map((grant) => grant.table)).toEqual(["a", "b"]);
  });

  it("returns nothing for a role with no grants", () => {
    expect(toMariadbGrants([])).toEqual([]);
  });

  // `grantNaming` keys a Grant CR's logical name on its table, so two grants for
  // one table would register two resources under the same name and abort the
  // preview with a duplicate-URN error — the role would never be provisioned at
  // all. Unioning them is both the fix and what the caller meant.
  it("merges two grants targeting the same table into one", () => {
    expect(
      toMariadbGrants([
        { privileges: ["SELECT"], objects: "orders" },
        { privileges: ["INSERT"], objects: "orders" },
      ])
    ).toEqual([{ privileges: ["INSERT", "SELECT"], table: "orders", grantOption: false }]);
  });

  it("produces identical output for reordered input", () => {
    const forwards = toMariadbGrants([
      { privileges: ["SELECT"], objects: "orders" },
      { privileges: ["INSERT", "UPDATE"], objects: "orders" },
      { privileges: ["SELECT"], objects: "customers" },
    ]);
    const backwards = toMariadbGrants([
      { privileges: ["SELECT"], objects: "customers" },
      { privileges: ["UPDATE", "INSERT"], objects: "orders" },
      { privileges: ["SELECT"], objects: "orders" },
    ]);

    expect(forwards).toEqual(backwards);
    expect(forwards).toEqual([
      { privileges: ["SELECT"], table: "customers", grantOption: false },
      { privileges: ["INSERT", "SELECT", "UPDATE"], table: "orders", grantOption: false },
    ]);
  });

  it("merges database-wide grants, however objects spelt them", () => {
    expect(
      toMariadbGrants([
        { privileges: ["SELECT"] },
        { privileges: ["INSERT"], objects: "all" },
        { privileges: ["select"], schema: "ignored" },
      ])
    ).toEqual([{ privileges: ["INSERT", "SELECT"], table: "*", grantOption: false }]);
  });

  it("keeps tables that genuinely differ apart", () => {
    const grants = toMariadbGrants([
      { privileges: ["SELECT"], objects: "orders" },
      { privileges: ["SELECT"], objects: "customers" },
    ]);

    expect(grants.map((grant) => grant.table)).toEqual(["customers", "orders"]);
  });

  // MariaDB's GRANT grammar refuses ALL PRIVILEGES alongside anything else, so a
  // union that kept both would render SQL the operator cannot execute.
  it("lets ALL PRIVILEGES absorb what it is merged with", () => {
    expect(
      toMariadbGrants([
        { privileges: ["SELECT"], objects: "orders" },
        { privileges: ["ALL PRIVILEGES"], objects: "orders" },
      ])
    ).toEqual([{ privileges: ["ALL PRIVILEGES"], table: "orders", grantOption: false }]);
  });

  // Privileges are SQL keywords that cannot be quoted, so an unvalidated one is
  // forwarded verbatim into mariadb-operator's SQL builder and fails at
  // reconcile time — visible only in operator logs, long after `pulumi up`
  // reported success.
  it.each(["DROP DATABASE", "SUPER", "PROCESS", "TRUNCATE"])(
    "rejects %s, which a database-scoped MariaDB GRANT cannot carry",
    (privilege) => {
      expect(() => toMariadbGrants([{ privileges: [privilege] }])).toThrow(AnyCloudError);
      expect(() => toMariadbGrants([{ privileges: [privilege] }])).toThrow(
        /unsupported privilege/i
      );
    }
  );

  it("reports UNSUPPORTED_PRIVILEGE and names MariaDB, not PostgreSQL", () => {
    try {
      toMariadbGrants([{ privileges: ["SUPER"] }]);
      expect.unreachable("toMariadbGrants should have thrown for SUPER");
    } catch (error) {
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_PRIVILEGE);
      expect((error as AnyCloudError).message).toContain("MariaDB");
    }
  });

  // MariaDB's privilege set is not PostgreSQL's: applying PostgreSQL's
  // allowlist here would reject these outright.
  it.each(["INDEX", "DROP", "EVENT", "EXECUTE", "CREATE VIEW", "DELETE HISTORY"])(
    "accepts %s, which MariaDB supports and PostgreSQL does not",
    (privilege) => {
      expect(toMariadbGrants([{ privileges: [privilege] }])[0]?.privileges).toEqual([privilege]);
    }
  );

  it("normalises case and internal whitespace before matching the allowlist", () => {
    expect(toMariadbGrants([{ privileges: ["  create   temporary tables "] }])).toEqual([
      { privileges: ["CREATE TEMPORARY TABLES"], table: "*", grantOption: false },
    ]);
  });
});

describe("OWNER_GRANT", () => {
  // The owner's Grant CR spec predates this refactor and must be reproduced
  // verbatim: ALL PRIVILEGES on every table, with GRANT OPTION.
  it("pins the owner's pre-refactor grant spec", () => {
    expect(OWNER_GRANT).toEqual({
      privileges: ["ALL PRIVILEGES"],
      table: "*",
      grantOption: true,
    });
  });
});

// The disambiguating hash belongs to the addRole() path alone. The owner's
// names are live in released stacks, and re-deriving one through
// `toIdentitySegment` would rename it — which Pulumi performs as a delete and
// recreate, regenerating the password in every credential Secret.
describe("owner naming is never hashed", () => {
  it.each([
    ["shared-maria", "analytics"],
    ["Shared_Maria", "An_Alytics"],
  ])("derives no hash suffix for %s/%s", (clusterName, dbName) => {
    const owner = ownerRoleNaming(clusterName, dbName);

    for (const name of [...pulumiNames(owner), ...kubernetesNames(owner)]) {
      expect(name).not.toMatch(/-[0-9a-f]{8}$/);
    }
  });
});
