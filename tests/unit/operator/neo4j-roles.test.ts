import { describe, expect, it } from "vitest";
import {
  additionalRoleNaming,
  ownerRoleNaming,
  type INeo4jRoleNaming,
} from "../../../src/operator/neo4j-roles.js";

/** RFC 1123 label: the character set Kubernetes enforces on a Job's name. */
const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** Longest `metadata.name` Kubernetes accepts for a Job. */
const JOB_NAME_MAX_LENGTH = 63;
/** Longest `metadata.name` Kubernetes accepts for a Secret. */
const SUBDOMAIN_MAX_LENGTH = 253;

/** Every name one naming object carries, in a flat list. */
const allNames = (naming: INeo4jRoleNaming): string[] => [
  naming.credentialResource,
  naming.credentialSecret,
  naming.initJobResource,
  naming.initJobName,
  naming.connectionResourcePrefix,
  naming.connectionSecret,
];

// Pulumi identifies a resource by its logical name. These strings are live in
// released stacks: renaming one deletes and recreates it, and for a credential
// Secret that regenerates the password and breaks every running application.
describe("ownerRoleNaming", () => {
  const naming = ownerRoleNaming("shared-neo4j", "graph");

  it.each([
    ["credentialResource", naming.credentialResource, "shared-neo4j-graph-neo4j-password"],
    ["credentialSecret", naming.credentialSecret, "shared-neo4j-graph-neo4j-user"],
    ["initJobResource", naming.initJobResource, "neo4j-init-user-shared-neo4j-graph"],
    ["initJobName", naming.initJobName, "neo4j-init-user-shared-neo4j-graph"],
    [
      "connectionResourcePrefix",
      naming.connectionResourcePrefix,
      "shared-neo4j-graph-neo4j-secret",
    ],
    ["connectionSecret", naming.connectionSecret, "shared-neo4j-graph-neo4j"],
  ])("pins %s to its pre-refactor value", (_field, actual, expected) => {
    expect(actual).toBe(expected);
  });
});

// The disambiguating hash belongs to the addRole() path alone. The owner's names
// are live in released stacks, and re-deriving one through `toIdentitySegment`
// would rename it — which Pulumi performs as a delete and recreate, regenerating
// the password in every credential Secret.
describe("owner naming is never hashed", () => {
  it.each([
    ["shared-neo4j", "graph"],
    ["Shared_Neo4j", "Gr_Aph"],
  ])("derives no hash suffix for %s/%s", (clusterName, dbName) => {
    for (const name of allNames(ownerRoleNaming(clusterName, dbName))) {
      expect(name).not.toMatch(/-[0-9a-f]{8}$/);
    }
  });
});

describe("additionalRoleNaming", () => {
  it("prefixes every name with the role", () => {
    const role = additionalRoleNaming("shared-neo4j", "graph", "reader");

    expect(role.credentialResource).toBe("shared-neo4j-graph-role-reader-3d094196-neo4j-password");
    expect(role.credentialSecret).toBe("shared-neo4j-graph-role-reader-3d094196-neo4j-user");
    expect(role.initJobResource).toBe("neo4j-init-user-shared-neo4j-graph-role-reader-3d094196");
    expect(role.initJobName).toBe("neo4j-init-user-shared-neo4j-graph-role-reader-3d094196");
    expect(role.connectionSecret).toBe("shared-neo4j-graph-role-reader-3d094196-neo4j");
  });

  // A deployment name, a database name and a username are all caller-controlled
  // and unbounded. `neo4j-init-user-{deployment}-{database}-role-{user}-{hash}`
  // passes 63 characters once they total roughly 32, and Kubernetes copies a
  // Job's name onto the `job-name` label of every Pod it creates — label values
  // are capped at 63. The untruncated name was accepted at preview and rejected
  // at apply, so the Job never ran and the account was never created.
  describe("with a long deployment, database and username", () => {
    const naming = additionalRoleNaming(
      "production-neo4j-graph-deployment-eu-central-1",
      "customer-analytics-warehouse-primary",
      "reporting-read-only-service-account"
    );

    it("bounds the Job name to what Kubernetes accepts for a Job", () => {
      expect(naming.initJobName.length).toBeLessThanOrEqual(JOB_NAME_MAX_LENGTH);
      expect(naming.initJobName).toMatch(DNS_1123_LABEL);
      expect(naming.initJobResource.length).toBeLessThanOrEqual(JOB_NAME_MAX_LENGTH);
    });

    it("keeps the truncated Job name disambiguated by a hash", () => {
      expect(naming.initJobName).toMatch(/-[0-9a-f]{8}$/);
    });

    it("bounds every other name to the subdomain limit", () => {
      for (const name of allNames(naming)) {
        expect(name.length).toBeLessThanOrEqual(SUBDOMAIN_MAX_LENGTH);
        expect(name).toMatch(DNS_1123_LABEL);
      }
    });
  });

  // Truncation is lossy in exactly the way sanitizing is: two names agreeing on
  // their first characters cut down to one string. Two Jobs under one name is a
  // duplicate URN at preview — or, worse, one Job for two accounts.
  it("keeps two long usernames apart after truncation", () => {
    const shared = "reporting-read-only-service-account";
    const first = additionalRoleNaming("production-neo4j-eu-central-1", "warehouse", `${shared}-a`);
    const second = additionalRoleNaming(
      "production-neo4j-eu-central-1",
      "warehouse",
      `${shared}-b`
    );

    expect(first.initJobName).not.toBe(second.initJobName);
    expect(first.initJobResource).not.toBe(second.initJobResource);
    expect(first.credentialSecret).not.toBe(second.credentialSecret);
  });

  it("keeps two long databases apart after truncation", () => {
    const shared = "customer-analytics-warehouse-primary";
    const first = additionalRoleNaming("production-neo4j-eu-central-1", `${shared}-a`, "reporting");
    const second = additionalRoleNaming(
      "production-neo4j-eu-central-1",
      `${shared}-b`,
      "reporting"
    );

    expect(first.initJobName).not.toBe(second.initJobName);
  });

  // A name that already fits keeps its readable form: truncation is the
  // exception, not something every name pays for.
  it("leaves a name that already fits untouched", () => {
    expect(additionalRoleNaming("neo", "g", "reader").initJobName).toBe(
      "neo4j-init-user-neo-g-role-reader-3d094196"
    );
  });
});
