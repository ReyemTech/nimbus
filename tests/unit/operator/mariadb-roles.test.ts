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
    const role = additionalRoleNaming("shared-maria", "analytics", "reader");

    expect(role.credentialResource).toBe("shared-maria-analytics-role-reader-secret");
    expect(role.credentialSecret).toBe("shared-maria-analytics-role-reader");
    expect(role.userResource).toBe("shared-maria-analytics-role-reader-user");
    expect(role.userMetadataName).toBe("shared-maria-analytics-role-reader");
    expect(role.connectionResourcePrefix).toBe("shared-maria-analytics-role-reader-connection");
    expect(role.connectionSecret).toBe("shared-maria-analytics-role-reader-mariadb");
  });

  // Keying grants on the table rather than on their position is what makes
  // reordering a role's `grants` array a no-op. A positional name would rewrite
  // `spec.table` on live Grant CRs — a field the operator's webhook may refuse,
  // turning a harmless reorder into a permanently failing apply.
  it("names each grant for the table it covers, not its position", () => {
    const role = additionalRoleNaming("shared-maria", "analytics", "reader");

    expect(role.grantNaming("events").resource).toBe(
      "shared-maria-analytics-role-reader-grant-events"
    );
    expect(role.grantNaming("events").metadataName).toBe(
      "shared-maria-analytics-role-reader-grant-events"
    );
  });

  it("renders the whole-database table as `all`", () => {
    const role = additionalRoleNaming("shared-maria", "analytics", "reader");

    expect(role.grantNaming("*").resource).toBe("shared-maria-analytics-role-reader-grant-all");
  });

  it("sanitizes table names that are not valid DNS-1123 labels", () => {
    const role = additionalRoleNaming("c", "d", "reader");

    expect(role.grantNaming("Order_Items").resource).toBe("c-d-role-reader-grant-order-items");
  });

  // Two grants on the same table would derive one shared logical name. That is
  // a hard duplicate-URN error at preview, before anything is applied.
  it("gives the same name to two grants on the same table", () => {
    const role = additionalRoleNaming("c", "d", "reader");

    expect(role.grantNaming("events").resource).toBe(role.grantNaming("events").resource);
  });

  // A role literally named "user", "grant", or "secret" is the case most likely
  // to land on one of the owner's stems. Names are only compared within their
  // own identifier space — a Pulumi logical name and a Kubernetes object name
  // may coincide harmlessly, since nothing resolves one against the other.
  it.each(["user", "grant", "secret", "password", "mariadb", "role"])(
    "does not collide with the owner's names for a role named %s",
    (roleName) => {
      const owner = ownerRoleNaming("c", "d");
      const role = additionalRoleNaming("c", "d", roleName);

      for (const value of pulumiNames(owner)) {
        expect(pulumiNames(role)).not.toContain(value);
      }
      for (const value of kubernetesNames(owner)) {
        expect(kubernetesNames(role)).not.toContain(value);
      }
    }
  );

  it("sanitizes role names that are not valid DNS-1123 labels", () => {
    const role = additionalRoleNaming("c", "d", "Read_Only");

    expect(role.credentialSecret).toBe("c-d-role-read-only");
    expect(role.userMetadataName).toBe("c-d-role-read-only");
  });
});

describe("toMariadbGrants", () => {
  it("upper-cases privileges as MariaDB spells them", () => {
    expect(toMariadbGrants([{ privileges: ["select", "Insert"] }])).toEqual([
      { privileges: ["SELECT", "INSERT"], table: "*", grantOption: false },
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
