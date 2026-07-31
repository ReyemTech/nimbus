import { describe, expect, it } from "vitest";
import {
  additionalRoleNaming,
  ownerRoleNaming,
  type ICnpgRoleNaming,
} from "../../../src/operator/cnpg-roles.js";

// Pulumi identifies a resource by its logical name. Changing one of these
// strings makes Pulumi delete and recreate the resource — for a credential
// Secret that regenerates the password and breaks every running application
// that reads it. These assertions pin the names extracted from cnpg.ts when
// role provisioning was factored out; a failure here is a release blocker,
// not a test to update.
describe("ownerRoleNaming", () => {
  const naming = ownerRoleNaming("shared-pg", "analytics");

  it.each([
    ["credentialResource", naming.credentialResource, "shared-pg-analytics-user-secret"],
    ["credentialSecret", naming.credentialSecret, "shared-pg-analytics-user"],
    ["basicAuthResource", naming.basicAuthResource, "shared-pg-analytics-role-secret"],
    ["basicAuthSecret", naming.basicAuthSecret, "shared-pg-analytics-role"],
    ["roleResource", naming.roleResource, "shared-pg-analytics-role-cr"],
    ["roleMetadataName", naming.roleMetadataName, "shared-pg-analytics-role"],
    ["connectionResourcePrefix", naming.connectionResourcePrefix, "shared-pg-analytics-secret"],
    ["connectionSecret", naming.connectionSecret, "shared-pg-analytics-pg"],
  ])("pins %s to its pre-refactor value", (_field, actual, expected) => {
    expect(actual).toBe(expected);
  });

  // The credential module derives the read-back resource's name by appending
  // "-read"; cnpg.ts used "{cluster}-{db}-user-secret-read" before the
  // refactor, so the derived name must match without an alias.
  it("derives the read-back name the previous implementation used", () => {
    expect(`${naming.credentialResource}-read`).toBe("shared-pg-analytics-user-secret-read");
  });
});

/** The subset of names Pulumi uses to identify resources. */
const pulumiNames = (naming: ICnpgRoleNaming): string[] => [
  naming.credentialResource,
  naming.basicAuthResource,
  naming.roleResource,
  naming.connectionResourcePrefix,
];

/** The subset of names Kubernetes objects are created under. */
const kubernetesNames = (naming: ICnpgRoleNaming): string[] => [
  naming.credentialSecret,
  naming.basicAuthSecret,
  naming.roleMetadataName,
  naming.connectionSecret,
];

describe("additionalRoleNaming", () => {
  it("prefixes every name with the role", () => {
    const role = additionalRoleNaming("shared-pg", "analytics", "reader");

    expect(role.credentialResource).toBe("shared-pg-analytics-role-reader-secret");
    expect(role.credentialSecret).toBe("shared-pg-analytics-role-reader");
    expect(role.basicAuthResource).toBe("shared-pg-analytics-role-reader-auth-secret");
    expect(role.basicAuthSecret).toBe("shared-pg-analytics-role-reader-auth");
    expect(role.roleResource).toBe("shared-pg-analytics-role-reader-cr");
    expect(role.roleMetadataName).toBe("shared-pg-analytics-role-reader");
    expect(role.connectionResourcePrefix).toBe("shared-pg-analytics-role-reader-connection");
    expect(role.connectionSecret).toBe("shared-pg-analytics-role-reader-pg");
  });

  // A role literally named "user", "role", or "secret" is the case most likely
  // to land on one of the owner's stems. Names are only compared within their
  // own identifier space — a Pulumi logical name and a Kubernetes object name
  // may coincide harmlessly, since nothing resolves one against the other.
  it.each(["user", "role", "secret", "pg", "db"])(
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
    expect(role.credentialSecret).toBe("c-d-role-read-only-7b1060cf");
    expect(role.roleMetadataName).toBe("c-d-role-read-only-7b1060cf");
  });

  // `Read_Only` and `read_only` are two distinct roles PostgreSQL will happily
  // hold at once, and sanitizing maps both to `read-only`. Two resources under
  // one Pulumi logical name is a duplicate-URN error that aborts the whole
  // preview — nothing is provisioned, including everything unrelated to the
  // clash — so the sanitized form is disambiguated by a hash of the raw name.
  it("keeps role names apart that sanitize to the same value", () => {
    const upper = additionalRoleNaming("c", "d", "Read_Only");
    const lower = additionalRoleNaming("c", "d", "read_only");

    expect(upper.credentialResource).not.toBe(lower.credentialResource);
    expect(upper.roleResource).not.toBe(lower.roleResource);
    expect(upper.connectionResourcePrefix).not.toBe(lower.connectionResourcePrefix);
  });

  // The disambiguator applies only where sanitizing lost something: an ordinary
  // role name keeps the plain, readable form it has always had.
  it("leaves a name that needs no sanitizing unsuffixed", () => {
    expect(additionalRoleNaming("c", "d", "read-only").credentialSecret).toBe("c-d-role-read-only");
  });
});
