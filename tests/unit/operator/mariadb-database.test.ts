import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { createSingleMariadbDatabaseInstance } from "../../../src/operator/mariadb-database.js";
import type {
  IDatabaseInstance,
  IDatabaseRole,
  IDatabaseRoleConfig,
} from "../../../src/operator/interfaces.js";
import { AnyCloudError, ERROR_CODES } from "../../../src/types/errors.js";

/** Pulumi logical names registered so far, in creation order. */
let registered: string[] = [];
/** Inputs each registration was made with, keyed by logical name. */
let inputsByName: Record<string, Record<string, unknown>> = {};

beforeAll(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => {
      registered.push(args.name);
      inputsByName[args.name] = args.inputs;
      return { id: `${args.name}-id`, state: { ...args.inputs, data: {} } };
    },
    call: () => ({}),
  });
});

beforeEach(() => {
  registered = [];
  inputsByName = {};
});

/** How often to re-check whether Pulumi's registrations have reached the mock. */
const POLL_INTERVAL_MS = 5;
/** How long to keep polling before declaring a registration lost. */
const POLL_TIMEOUT_MS = 15_000;

/**
 * Wait until every named resource has been registered.
 *
 * Pulumi registers resources asynchronously, so assertions have to wait for the
 * mock to see them. Polling for the specific names a test cares about is what
 * keeps this from being a fixed sleep that a slow CI runner can outrun, and it
 * reports exactly which registration never arrived.
 */
async function awaitRegistered(...names: string[]): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (names.every((name) => registered.includes(name))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const missing = names.filter((name) => !registered.includes(name));
  throw new Error(`timed out waiting for registrations: ${missing.join(", ")}`);
}

/** Every logical name one call to `makeDatabase({ namespaces: ["app"] })` registers. */
const OWNER_RESOURCES = [
  "shared-maria-analytics-database",
  "shared-maria-analytics-password-secret",
  "shared-maria-analytics-password-secret-read",
  "shared-maria-analytics-user",
  "shared-maria-analytics-grant",
  "shared-maria-analytics-secret-app",
];

/** Build a database instance against mocked Pulumi resources. */
function makeDatabase(
  config: Parameters<typeof createSingleMariadbDatabaseInstance>[0]["config"] = {
    namespaces: ["app"],
  }
): IDatabaseInstance {
  const provider = new k8s.Provider("test-provider", {});
  const mariadb = new k8s.apiextensions.CustomResource(
    "test-mariadb",
    { apiVersion: "k8s.mariadb.com/v1alpha1", kind: "MariaDB", metadata: { name: "shared-maria" } },
    { provider }
  );

  return createSingleMariadbDatabaseInstance({
    clusterName: "shared-maria",
    dbName: "analytics",
    config,
    endpoint: pulumi.output("shared-maria.data.svc.cluster.local"),
    port: pulumi.output(3306),
    mariadb,
    provider,
  });
}

/** Narrow away `addRole`'s optionality — MariaDB always implements it. */
function addRoleOf(
  db: IDatabaseInstance
): (name: string, config?: IDatabaseRoleConfig) => IDatabaseRole {
  const { addRole } = db;
  if (!addRole) {
    throw new Error("MariaDB database instances must implement addRole()");
  }
  return addRole.bind(db);
}

/** Resolve an Output to its underlying value. */
function unwrap<T>(output: pulumi.Output<T>): Promise<T> {
  return new Promise((resolve) => {
    output.apply(resolve);
  });
}

/** Pulumi's wire sentinel marking a serialized secret value. */
const SECRET_SIGNATURE = "4dabf18193072939515e22adb298388d";

/**
 * Unwrap a value the Pulumi engine received as a secret.
 *
 * A Secret's whole `stringData` is hoisted to a secret because the generated
 * password inside it is one, so the mock sees `{ <sig>: ..., value: {...} }`.
 */
function unwrapSecret(value: unknown): Record<string, unknown> {
  const record = value as Record<string, unknown>;
  return SECRET_SIGNATURE in record ? (record["value"] as Record<string, unknown>) : record;
}

/** Read the `spec` of a registered custom resource. */
function specOf(name: string): Record<string, unknown> {
  const inputs = inputsByName[name];
  if (!inputs) {
    throw new Error(`no resource named ${name} was registered`);
  }
  return inputs["spec"] as Record<string, unknown>;
}

describe("createSingleMariadbDatabaseInstance", () => {
  // Pulumi identifies a resource by its logical name; renaming one deletes and
  // recreates it, and for a credential Secret that regenerates the password and
  // breaks every running application. These are the names mariadb.ts registered
  // before role provisioning was factored out. A failure here is a release
  // blocker, not a test to update.
  it.each([
    "shared-maria-analytics-database",
    "shared-maria-analytics-password-secret",
    "shared-maria-analytics-user",
    "shared-maria-analytics-grant",
    "shared-maria-analytics-secret-app",
  ])("registers %s under its pre-refactor logical name", async (name) => {
    makeDatabase();
    await awaitRegistered(name);

    expect(registered).toContain(name);
  });

  // The read-back is the one deliberate rename: `createRoleCredentials` derives
  // it as `{credentialResource}-read`, so it moved from
  // `...-password-read` to `...-password-secret-read`. Secret.get() registers an
  // EXTERNAL resource Pulumi does not own, so dropping the old one churns state
  // without issuing any Delete against the live Secret — no alias needed.
  it("derives the read-back name from the credential resource", async () => {
    makeDatabase();
    await awaitRegistered(...OWNER_RESOURCES);

    expect(registered).toContain("shared-maria-analytics-password-secret-read");
    expect(registered).not.toContain("shared-maria-analytics-password-read");
  });

  // The owner's Secret has always held only `password`; the User CR names the
  // account. Adding a `username` key would change the schema of a Secret live
  // applications already read.
  it("keeps the owner credential Secret password-only", async () => {
    makeDatabase();
    await awaitRegistered("shared-maria-analytics-password-secret");

    const stringData = inputsByName["shared-maria-analytics-password-secret"]?.["stringData"];
    expect(Object.keys(unwrapSecret(stringData))).toEqual(["password"]);
  });

  it("keeps the owner's pre-refactor Grant spec", async () => {
    makeDatabase();
    await awaitRegistered("shared-maria-analytics-grant");

    expect(specOf("shared-maria-analytics-grant")).toMatchObject({
      privileges: ["ALL PRIVILEGES"],
      database: "analytics",
      table: "*",
      username: "analytics",
      grantOption: true,
    });
  });

  // Writing `host: "%"` explicitly would diff a field mariadb-operator's
  // webhook treats as immutable on every stack that already exists.
  it.each(["shared-maria-analytics-user", "shared-maria-analytics-grant"])(
    "omits spec.host from the owner's %s",
    async (name) => {
      makeDatabase();
      await awaitRegistered(name);

      expect(specOf(name)).not.toHaveProperty("host");
    }
  );

  it("names the owner after the database", async () => {
    const db = makeDatabase();
    await awaitRegistered(...OWNER_RESOURCES);

    expect(specOf("shared-maria-analytics-user")).toMatchObject({ name: "analytics" });
    await expect(unwrap(pulumi.output(db.secrets["app"]))).resolves.toBe(
      "shared-maria-analytics-mariadb"
    );
  });
});

// Nothing in the MariaDB backend executes SQL — provisioning is Database/User/
// Grant CRs all the way down — so `sql` cannot be honoured. This branch refuses
// every option it cannot honour (`owner`, `login: false`, `environments`,
// `grants`); accepting `sql` and dropping it would be the one exception, and a
// silently skipped `CREATE EXTENSION` is exactly the kind of gap nothing in the
// Pulumi diff would explain.
describe("config.sql", () => {
  it("rejects sql, which MariaDB cannot apply", () => {
    expect(() => makeDatabase({ namespaces: ["app"], sql: ["SELECT 1;"] })).toThrow(AnyCloudError);
    expect(() => makeDatabase({ namespaces: ["app"], sql: ["SELECT 1;"] })).toThrow(
      /cannot use "sql" on MariaDB/
    );
  });

  it("reports UNSUPPORTED_ROLE_OPTION and names the database", () => {
    try {
      makeDatabase({ namespaces: ["app"], sql: ["SELECT 1;"] });
      expect.unreachable("createDatabase should have thrown for sql");
    } catch (error) {
      expect(error).toBeInstanceOf(AnyCloudError);
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_ROLE_OPTION);
      expect((error as AnyCloudError).message).toContain('"analytics"');
    }
  });

  // An empty list still asks for SQL to be applied, and is just as unapplicable.
  it("rejects an empty sql list as well", () => {
    expect(() => makeDatabase({ namespaces: ["app"], sql: [] })).toThrow(AnyCloudError);
  });
});

// `ignoreChanges` suppresses diffs only on resources that already exist, so
// honouring `owner` would work on a greenfield stack and break only on upgrade:
// the account would keep the database's name while `username` and `uri` flipped
// in every replicated connection Secret. An option whose correctness depends on
// how old the stack is is worse than one that is refused, so it is refused.
describe("config.owner", () => {
  it("rejects an owner that differs from the database name", () => {
    expect(() => makeDatabase({ namespaces: ["app"], owner: "etl" })).toThrow(AnyCloudError);
    expect(() => makeDatabase({ namespaces: ["app"], owner: "etl" })).toThrow(
      /always the database name/
    );
  });

  it("reports UNSUPPORTED_ROLE_OPTION and points at addRole()", () => {
    try {
      makeDatabase({ namespaces: ["app"], owner: "etl" });
      expect.unreachable("createDatabase should have thrown for a differing owner");
    } catch (error) {
      expect(error).toBeInstanceOf(AnyCloudError);
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_ROLE_OPTION);
      expect((error as AnyCloudError).message).toContain('addRole("etl")');
    }
  });

  it("provisions nothing before rejecting the owner", async () => {
    const provider = new k8s.Provider("owner-guard-provider", {});
    const mariadb = new k8s.apiextensions.CustomResource(
      "owner-guard-mariadb",
      {
        apiVersion: "k8s.mariadb.com/v1alpha1",
        kind: "MariaDB",
        metadata: { name: "shared-maria" },
      },
      { provider }
    );
    await awaitRegistered("owner-guard-mariadb");
    const before = [...registered];

    expect(() =>
      createSingleMariadbDatabaseInstance({
        clusterName: "shared-maria",
        dbName: "analytics",
        config: { namespaces: ["app"], owner: "etl" },
        endpoint: pulumi.output("shared-maria.data.svc.cluster.local"),
        port: pulumi.output(3306),
        mariadb,
        provider,
      })
    ).toThrow(AnyCloudError);

    expect(registered).toEqual(before);
  });

  // An owner spelled out redundantly is the same owner, so it must be accepted.
  it("accepts an owner equal to the database name", async () => {
    makeDatabase({ namespaces: ["app"], owner: "analytics" });
    await awaitRegistered(...OWNER_RESOURCES);

    expect(specOf("shared-maria-analytics-user")).toMatchObject({ name: "analytics" });
  });
});

describe("addRole", () => {
  // A second User CR for the same MariaDB account would bind it to a different
  // password Secret; both CRs then reconcile that password forever and the
  // owner's replicated connection Secrets stop matching the live credential.
  // The two CRs have distinct Pulumi logical names, so `pulumi preview` reports
  // no conflict — this only surfaces in production.
  it("rejects the database owner's own name", () => {
    const addRole = addRoleOf(makeDatabase());

    expect(() => addRole("analytics")).toThrow(AnyCloudError);
    expect(() => addRole("analytics")).toThrow(/owner of database "analytics"/);
    expect(() => addRole("analytics")).toThrow(/createDatabase/);
  });

  it("reports UNSUPPORTED_ROLE_OPTION and names the role and the database", () => {
    const addRole = addRoleOf(makeDatabase());

    try {
      addRole("analytics");
      expect.unreachable("addRole should have thrown for the owner's name");
    } catch (error) {
      expect(error).toBeInstanceOf(AnyCloudError);
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_ROLE_OPTION);
      expect((error as AnyCloudError).message).toContain('"analytics"');
    }
  });

  it("provisions nothing before rejecting the owner", async () => {
    const addRole = addRoleOf(makeDatabase());
    await awaitRegistered(...OWNER_RESOURCES);
    const before = [...registered];

    expect(() => addRole("analytics")).toThrow(AnyCloudError);

    expect(registered).toEqual(before);
  });

  // Every MariaDB account is a login account, so silently accepting
  // `login: false` would hand back a role that can log in.
  it("rejects login: false, which MariaDB cannot express", () => {
    const addRole = addRoleOf(makeDatabase());

    expect(() => addRole("reader", { login: false })).toThrow(AnyCloudError);
    expect(() => addRole("reader", { login: false })).toThrow(/login account/);
  });

  it("propagates INVALID_GRANT for a grant with no privileges", () => {
    const addRole = addRoleOf(makeDatabase());

    try {
      addRole("reader", { grants: [{ privileges: [] }] });
      expect.unreachable("addRole should have thrown for an empty privilege list");
    } catch (error) {
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.INVALID_GRANT);
    }
  });

  it("returns the role with its replicated Secrets", async () => {
    const db = makeDatabase();
    const role = addRoleOf(db)("reader", {
      namespaces: ["app"],
      grants: [{ privileges: ["select"], schema: "marts" }],
    });
    await awaitRegistered("shared-maria-analytics-role-reader-connection-app");

    expect(role.name).toBe("reader");
    expect(role.databaseName).toBe("analytics");
    expect(role.clusterName).toBe("shared-maria");
    await expect(unwrap(pulumi.output(role.secrets["app"]))).resolves.toBe(
      "shared-maria-analytics-role-reader-mariadb"
    );
    expect(registered).toContain("shared-maria-analytics-role-reader-user");
    expect(registered).toContain("shared-maria-analytics-role-reader-connection-app");
  });

  // Grant CRs are named for the table they cover, so the pair below lands on
  // `-grant-all` and `-grant-events` regardless of the order they are listed in.
  it("maps each grant onto its own Grant CR, named for its table", async () => {
    const db = makeDatabase();
    addRoleOf(db)("reader", {
      grants: [
        { privileges: ["select"], objects: "all" },
        { privileges: ["insert", "update"], objects: "events" },
      ],
    });
    await awaitRegistered(
      "shared-maria-analytics-role-reader-grant-all",
      "shared-maria-analytics-role-reader-grant-events"
    );

    expect(specOf("shared-maria-analytics-role-reader-grant-all")).toMatchObject({
      privileges: ["SELECT"],
      database: "analytics",
      table: "*",
      username: "reader",
      host: "%",
      grantOption: false,
    });
    expect(specOf("shared-maria-analytics-role-reader-grant-events")).toMatchObject({
      privileges: ["INSERT", "UPDATE"],
      table: "events",
      grantOption: false,
    });
  });

  // Reordering the array must not move a grant onto a different logical name —
  // that would rewrite `spec.table` on a live CR, which the operator's webhook
  // may refuse outright.
  it("gives a reordered grants array the identical set of logical names", async () => {
    addRoleOf(makeDatabase())("reader", {
      grants: [
        { privileges: ["insert"], objects: "events" },
        { privileges: ["select"], objects: "all" },
      ],
    });
    await awaitRegistered(
      "shared-maria-analytics-role-reader-grant-all",
      "shared-maria-analytics-role-reader-grant-events"
    );

    expect(specOf("shared-maria-analytics-role-reader-grant-events")).toMatchObject({
      privileges: ["INSERT"],
      table: "events",
    });
    expect(specOf("shared-maria-analytics-role-reader-grant-all")).toMatchObject({
      privileges: ["SELECT"],
      table: "*",
    });
  });

  it("applies engineOptions.mariadb to the User and Grant CRs", async () => {
    const db = makeDatabase();
    addRoleOf(db)("reader", {
      grants: [{ privileges: ["SELECT"] }],
      engineOptions: { mariadb: { host: "10.0.%", maxUserConnections: 5 } },
    });
    await awaitRegistered(
      "shared-maria-analytics-role-reader-user",
      "shared-maria-analytics-role-reader-grant-all"
    );

    expect(specOf("shared-maria-analytics-role-reader-user")).toMatchObject({
      name: "reader",
      host: "10.0.%",
      maxUserConnections: 5,
    });
    expect(specOf("shared-maria-analytics-role-reader-grant-all")).toMatchObject({
      host: "10.0.%",
    });
  });

  it("creates no Grant CR for a role with no grants", async () => {
    const db = makeDatabase();
    addRoleOf(db)("reader", { namespaces: ["app"] });
    await awaitRegistered("shared-maria-analytics-role-reader-connection-app");

    expect(registered).toContain("shared-maria-analytics-role-reader-user");
    expect(registered.some((name) => name.includes("role-reader-grant"))).toBe(false);
  });
  // Validation lives in one shared choke point (`assertValidRoleName`) rather
  // than being argued separately per engine. MariaDB routes privileges through
  // Grant CRs rather than SQL, so this is defence in depth here — but the guard
  // must be wired in, and that is what this asserts.
  it("rejects a role name containing an identifier quote character", () => {
    const addRole = addRoleOf(makeDatabase());

    expect(() => addRole("read`er")).toThrow(AnyCloudError);
    expect(() => addRole("read`er")).toThrow(/backtick/);
  });
});
