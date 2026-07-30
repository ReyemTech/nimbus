import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { createSingleCnpgDatabaseInstance } from "../../../src/operator/cnpg-database.js";
import type {
  IDatabaseInstance,
  IDatabaseRole,
  IDatabaseRoleConfig,
} from "../../../src/operator/interfaces.js";
import { AnyCloudError, ERROR_CODES } from "../../../src/types/errors.js";

/** Pulumi logical names registered so far, in creation order. */
let registered: string[] = [];

beforeAll(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      registered.push(args.name);
      return { id: `${args.name}-id`, state: { ...args.inputs, data: {} } };
    },
    call: () => ({}),
  });
});

beforeEach(() => {
  registered = [];
});

/** Wait for Pulumi's asynchronous resource registrations to reach the mock. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

/**
 * Build a database instance against mocked Pulumi resources.
 *
 * `dbName` and `owner` are deliberately different by default: `ownerRoleNaming`
 * must key off the database name, not the owner, or a database with an explicit
 * owner would produce different logical names than it did before the refactor.
 */
function makeDatabase(
  config: Parameters<typeof createSingleCnpgDatabaseInstance>[0]["config"] = {
    namespaces: ["app"],
    owner: "etl",
  }
): IDatabaseInstance {
  const provider = new k8s.Provider("test-provider", {});
  const cluster = new k8s.apiextensions.CustomResource(
    "test-cluster",
    { apiVersion: "postgresql.cnpg.io/v1", kind: "Cluster", metadata: { name: "shared-pg" } },
    { provider }
  );

  return createSingleCnpgDatabaseInstance({
    clusterName: "shared-pg",
    dbName: "analytics",
    config,
    endpoint: pulumi.output("shared-pg-rw.data.svc.cluster.local"),
    port: pulumi.output(5432),
    pgVersion: "17",
    cluster,
    provider,
  });
}

/** Narrow away `addRole`'s optionality — CNPG always implements it. */
function addRoleOf(
  db: IDatabaseInstance
): (name: string, config?: IDatabaseRoleConfig) => IDatabaseRole {
  const { addRole } = db;
  if (!addRole) {
    throw new Error("CNPG database instances must implement addRole()");
  }
  return addRole.bind(db);
}

/** Resolve an Output to its underlying value. */
function unwrap<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => {
    output.apply(resolve);
  });
}

describe("createSingleCnpgDatabaseInstance", () => {
  // Pulumi identifies a resource by its logical name; renaming one deletes and
  // recreates it, and for a credential Secret that regenerates the password and
  // breaks every running application. These are the names cnpg.ts registered
  // before role provisioning was factored out. A failure here is a release
  // blocker, not a test to update.
  it.each([
    "shared-pg-analytics-user-secret",
    "shared-pg-analytics-user-secret-read",
    "shared-pg-analytics-role-secret",
    "shared-pg-analytics-role-cr",
    "shared-pg-analytics-database-cr",
    "shared-pg-analytics-secret-app",
  ])("registers %s under its pre-refactor logical name", async (name) => {
    makeDatabase();
    await settle();

    expect(registered).toContain(name);
  });

  it("applies config.sql as an owner-scoped Job and nothing when omitted", async () => {
    makeDatabase({ namespaces: ["app"], owner: "etl", sql: ["CREATE EXTENSION IF NOT EXISTS x;"] });
    await settle();

    expect(registered.some((name) => name.startsWith("cnpg-grants-shared-pg-analytics-etl"))).toBe(
      true
    );

    registered = [];
    makeDatabase();
    await settle();

    expect(registered.some((name) => name.startsWith("cnpg-grants-"))).toBe(false);
  });
});

describe("addRole", () => {
  // A second DatabaseRole CR for the same PostgreSQL role would bind that role
  // to a different basic-auth Secret; both controllers then reconcile its
  // password forever and the owner's replicated connection Secrets stop
  // matching the live credential. The two CRs have distinct Pulumi logical
  // names, so `pulumi preview` reports no conflict — this only surfaces in
  // production, which is why it must be rejected up front.
  it("rejects the database owner's own name", () => {
    const addRole = addRoleOf(makeDatabase());

    expect(() => addRole("etl")).toThrow(AnyCloudError);
    expect(() => addRole("etl")).toThrow(/owner of database "analytics"/);
    expect(() => addRole("etl")).toThrow(/createDatabase/);
  });

  it("reports UNSUPPORTED_ROLE_OPTION and names the role and the database", () => {
    const addRole = addRoleOf(makeDatabase());

    try {
      addRole("etl");
      expect.unreachable("addRole should have thrown for the owner's name");
    } catch (error) {
      expect(error).toBeInstanceOf(AnyCloudError);
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_ROLE_OPTION);
      expect((error as AnyCloudError).message).toContain('"etl"');
      expect((error as AnyCloudError).message).toContain('"analytics"');
    }
  });

  // The owner defaults to the database name, so the same guard must catch a
  // role named after the database when no explicit owner was configured.
  it("rejects the database name when no explicit owner is configured", () => {
    const addRole = addRoleOf(makeDatabase({ namespaces: ["app"] }));

    expect(() => addRole("analytics")).toThrow(AnyCloudError);
  });

  it("provisions nothing before rejecting the owner", async () => {
    const addRole = addRoleOf(makeDatabase());
    await settle();
    const before = [...registered];

    expect(() => addRole("etl")).toThrow(AnyCloudError);
    await settle();

    expect(registered).toEqual(before);
  });

  it("returns the role with its replicated Secrets", async () => {
    const db = makeDatabase();
    const role = addRoleOf(db)("reader", {
      namespaces: ["app"],
      grants: [{ privileges: ["SELECT"], schema: "marts" }],
    });
    await settle();

    expect(role.name).toBe("reader");
    expect(role.databaseName).toBe("analytics");
    expect(role.clusterName).toBe("shared-pg");
    await expect(unwrap(pulumi.output(role.secrets["app"]))).resolves.toBe(
      "shared-pg-analytics-role-reader-pg"
    );
    expect(registered).toContain("shared-pg-analytics-role-reader-cr");
    expect(registered).toContain("shared-pg-analytics-role-reader-connection-app");
    expect(
      registered.some((name) => name.startsWith("cnpg-grants-shared-pg-analytics-reader"))
    ).toBe(true);
  });

  it("creates no grant Job for a role with no grants", async () => {
    const db = makeDatabase();
    addRoleOf(db)("reader", { namespaces: ["app"] });
    await settle();

    expect(registered).toContain("shared-pg-analytics-role-reader-cr");
    expect(
      registered.some((name) => name.startsWith("cnpg-grants-shared-pg-analytics-reader"))
    ).toBe(false);
  });
});
