import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { createSingleCnpgDatabaseInstance } from "../../../src/operator/cnpg-database.js";
import { createCnpgRoleRegistry } from "../../../src/operator/cnpg-common.js";
import type { IRoleRegistry } from "../../../src/operator/role-registry.js";
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
  },
  dbName = "analytics",
  roleRegistry: IRoleRegistry = createCnpgRoleRegistry("shared-pg")
): IDatabaseInstance {
  const provider = new k8s.Provider("test-provider", {});
  const cluster = new k8s.apiextensions.CustomResource(
    "test-cluster",
    { apiVersion: "postgresql.cnpg.io/v1", kind: "Cluster", metadata: { name: "shared-pg" } },
    { provider }
  );

  return createSingleCnpgDatabaseInstance({
    clusterName: "shared-pg",
    dbName,
    config,
    endpoint: pulumi.output("shared-pg-rw.data.svc.cluster.local"),
    port: pulumi.output(5432),
    pgVersion: "17",
    cluster,
    roleRegistry,
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

/** Logical name of the grant Job registered for a role, or undefined if none. */
function grantJobNameFor(role: string): string | undefined {
  return registered.find(
    (name) => name.startsWith(`cnpg-grants-shared-pg-analytics-${role}`) && !name.endsWith("-sql")
  );
}

/** The SQL the grant Job's ConfigMap mounts, for the role's Job. */
function grantSqlFor(role: string): string {
  const jobName = grantJobNameFor(role);
  if (!jobName) {
    throw new Error(`no grant Job was registered for role "${role}"`);
  }
  const data = inputsByName[`${jobName}-sql`]?.["data"] as Record<string, string> | undefined;
  if (!data?.["grants.sql"]) {
    throw new Error(`the grant Job for role "${role}" mounted no SQL`);
  }
  return data["grants.sql"];
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
 * Read a registered Secret's `stringData`.
 *
 * A connection Secret's whole `stringData` is hoisted to a secret because the
 * password inside it is one, so the mock sees `{ <sig>: ..., value: {...} }`.
 */
function stringDataOf(name: string): Record<string, unknown> {
  const value = inputsByName[name]?.["stringData"] as Record<string, unknown> | undefined;
  if (!value) {
    throw new Error(`no Secret named ${name} was registered with stringData`);
  }
  return SECRET_SIGNATURE in value ? (value["value"] as Record<string, unknown>) : value;
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

  // An empty database name used to pass straight through: the owner defaults to
  // the database name and would have been caught by the role validator, but the
  // default config here sets `owner: "etl"` — exactly the case a caller is most
  // likely to have configured — so nothing looked at the name at all and a full
  // set of CRs, Jobs and Secrets was registered for a database with no name.
  it.each(["", " "])("rejects a blank database name (%p)", (dbName) => {
    expect(() => makeDatabase({ namespaces: ["app"], owner: "etl" }, dbName)).toThrow(
      AnyCloudError
    );
    expect(() => makeDatabase({ namespaces: ["app"], owner: "etl" }, dbName)).toThrow(/is empty/);
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

// PostgreSQL roles live at the cluster level, so two databases in one cluster
// asking for `reader` are asking for the SAME role — each pointing it at its own
// generated password Secret. Their Pulumi logical names differ (they are derived
// from the database name), so preview reports nothing and the two DatabaseRole
// controllers rewrite the password against each other in production.
describe("cluster-scoped role names", () => {
  it("rejects the same role name added on two databases in one cluster", () => {
    const registry = createCnpgRoleRegistry("shared-pg");
    const billing = addRoleOf(makeDatabase({ namespaces: ["app"] }, "billing", registry));
    const analytics = addRoleOf(makeDatabase({ namespaces: ["app"] }, "analytics", registry));

    billing("reader");

    expect(() => analytics("reader")).toThrow(AnyCloudError);
    expect(() => analytics("reader")).toThrow(/cluster-global/);
  });

  it("names the role, both databases, and the cluster", () => {
    const registry = createCnpgRoleRegistry("shared-pg");
    const billing = addRoleOf(makeDatabase({ namespaces: ["app"] }, "billing", registry));
    const analytics = addRoleOf(makeDatabase({ namespaces: ["app"] }, "analytics", registry));
    billing("reader");

    try {
      analytics("reader");
      expect.unreachable("addRole should have thrown for a cluster-global collision");
    } catch (error) {
      expect(error).toBeInstanceOf(AnyCloudError);
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_ROLE_OPTION);
      const { message } = error as AnyCloudError;
      expect(message).toContain('"reader"');
      expect(message).toContain('"billing"');
      expect(message).toContain('"analytics"');
      expect(message).toContain('cluster "shared-pg"');
    }
  });

  it("rejects an addRole() name that is another database's owner", () => {
    const registry = createCnpgRoleRegistry("shared-pg");
    // "billing"'s owner role is `etl`, which is the same cluster-global role
    // `analytics` would be asking for.
    makeDatabase({ namespaces: ["app"], owner: "etl" }, "billing", registry);
    const analytics = addRoleOf(makeDatabase({ namespaces: ["app"] }, "analytics", registry));

    expect(() => analytics("etl")).toThrow(/already claimed by database "billing"/);
  });

  it("rejects two databases in one cluster declaring the same owner", () => {
    const registry = createCnpgRoleRegistry("shared-pg");
    makeDatabase({ namespaces: ["app"], owner: "shared" }, "billing", registry);

    expect(() =>
      makeDatabase({ namespaces: ["app"], owner: "shared" }, "analytics", registry)
    ).toThrow(/already claimed by database "billing"/);
  });

  it("rejects the same role added twice on one database", () => {
    const addRole = addRoleOf(makeDatabase({ namespaces: ["app"] }, "analytics"));
    addRole("reader");

    expect(() => addRole("reader")).toThrow(/already claimed by database "analytics"/);
  });

  it("allows the same role name on separate clusters", () => {
    const billing = addRoleOf(
      makeDatabase({ namespaces: ["app"] }, "billing", createCnpgRoleRegistry("pg-a"))
    );
    const analytics = addRoleOf(
      makeDatabase({ namespaces: ["app"] }, "analytics", createCnpgRoleRegistry("pg-b"))
    );

    expect(() => {
      billing("reader");
      analytics("reader");
    }).not.toThrow();
  });
});

// A role name is caller-controlled and the validator rejects only what would
// break a database identifier, so `@` and `:` reach the URI builder. Raw, they
// re-partition the URI: `reporting@corp` makes a parser read user `reporting`
// and a host taken from the middle of the password. The separate `username` and
// `password` keys would be perfectly correct all the while.
describe("connection URI encoding", () => {
  it.each([
    ["reporting@corp", "reporting-corp-796adff4", "reporting%40corp"],
    ["reader:ro", "reader-ro-9e580d70", "reader%3Aro"],
  ])("percent-encodes %s in the uri", async (roleName, resourceStem, encoded) => {
    addRoleOf(makeDatabase())(roleName, { namespaces: ["app"] });
    await settle();

    const stringData = stringDataOf(`shared-pg-analytics-role-${resourceStem}-connection-app`);

    expect(stringData["uri"]).toBe(
      `postgresql://${encoded}:@shared-pg-rw.data.svc.cluster.local:5432/analytics?sslmode=require`
    );
    // The plain keys stay raw — a client consumes them literally, not as a URI.
    expect(stringData["username"]).toBe(roleName);
    expect(stringData["database"]).toBe("analytics");
  });

  it("parses back to the role name it was built from", async () => {
    addRoleOf(makeDatabase())("reporting@corp", { namespaces: ["app"] });
    await settle();

    const uri = stringDataOf("shared-pg-analytics-role-reporting-corp-796adff4-connection-app")[
      "uri"
    ] as string;
    const parsed = new URL(uri);

    expect(decodeURIComponent(parsed.username)).toBe("reporting@corp");
    expect(parsed.hostname).toBe("shared-pg-rw.data.svc.cluster.local");
    expect(decodeURIComponent(parsed.pathname)).toBe("/analytics");
  });

  it("leaves an ordinary role name unencoded", async () => {
    addRoleOf(makeDatabase())("reporting", { namespaces: ["app"] });
    await settle();

    expect(stringDataOf("shared-pg-analytics-role-reporting-637d7bec-connection-app")["uri"]).toBe(
      "postgresql://reporting:@shared-pg-rw.data.svc.cluster.local:5432/analytics?sslmode=require"
    );
  });
});

// The role registry keys raw names, so `Read_Only` and `read_only` are both
// accepted — they are two distinct roles PostgreSQL will hold at once. Deriving
// their resource names by sanitizing alone gave them ONE logical name each, and
// a duplicate URN aborts the entire preview rather than just those resources.
describe("resource names for roles that sanitize alike", () => {
  it("registers distinct resources for Read_Only and read_only", async () => {
    const addRole = addRoleOf(makeDatabase());

    addRole("Read_Only", { namespaces: ["app"] });
    addRole("read_only", { namespaces: ["app"] });
    await settle();

    const roleResources = registered.filter((name) => name.includes("-role-read-only"));
    expect(new Set(roleResources).size).toBe(roleResources.length);
    expect(roleResources.length).toBeGreaterThan(0);
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
      "shared-pg-analytics-role-reader-3d094196-pg"
    );
    expect(registered).toContain("shared-pg-analytics-role-reader-3d094196-cr");
    expect(registered).toContain("shared-pg-analytics-role-reader-3d094196-connection-app");
    expect(
      registered.some((name) => name.startsWith("cnpg-grants-shared-pg-analytics-reader"))
    ).toBe(true);
  });

  // Omitting `grants` means "nimbus does not manage this role's privileges",
  // so there is nothing to reconcile and no Job to run.
  it("creates no grant Job when grants is omitted", async () => {
    const db = makeDatabase();
    addRoleOf(db)("reader", { namespaces: ["app"] });
    await settle();

    expect(registered).toContain("shared-pg-analytics-role-reader-3d094196-cr");
    expect(grantJobNameFor("reader")).toBeUndefined();
  });

  // `grants: []` is the opposite: a role that should hold no privileges. It is
  // what a config looks like the moment its last grant is removed, and if that
  // were treated as "nothing to do" the role would keep every privilege it had,
  // forever — the revoke-then-grant script is the only thing that takes them
  // away. MariaDB does revoke here (its Grant CRs are deleted), so skipping the
  // Job would also split the two backends on the headline promise.
  it("creates a revoke-only grant Job for an empty grants list", async () => {
    const db = makeDatabase();
    addRoleOf(db)("reader", { namespaces: ["app"], grants: [] });
    await settle();

    expect(grantJobNameFor("reader")).toBeDefined();

    const sql = grantSqlFor("reader");
    expect(sql).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA");
    expect(sql).not.toContain("GRANT SELECT");
  });

  // The Secret must not become readable before the revoke has run, or a
  // consumer could connect with privileges the config says are gone.
  it("makes the connection Secret wait on the revoke-only Job", async () => {
    const db = makeDatabase();
    addRoleOf(db)("reader", { namespaces: ["app"], grants: [] });
    await settle();

    expect(registered.indexOf(grantJobNameFor("reader") as string)).toBeLessThan(
      registered.indexOf("shared-pg-analytics-role-reader-3d094196-connection-app")
    );
  });
  // Validation lives in one shared choke point (`assertValidRoleName`) rather
  // than being argued separately per engine. CNPG's grant SQL quotes
  // identifiers, so this is defence in depth here — but the guard must be wired
  // in, and that is what this asserts.
  it("rejects a role name containing an identifier quote character", () => {
    const addRole = addRoleOf(makeDatabase());

    expect(() => addRole('read"er')).toThrow(AnyCloudError);
    expect(() => addRole('read"er')).toThrow(/double quote/);
  });

  // A `mariadb` block names an engine that will never run this role. Accepting
  // it provisioned the role successfully with the requested host and connection
  // cap simply absent — the silent drop every other unhonourable option here is
  // refused for.
  it("rejects an engineOptions block belonging to another engine", () => {
    const addRole = addRoleOf(makeDatabase());
    const foreign = { engineOptions: { mariadb: { host: "10.0.0.1" } } };

    expect(() => addRole("reader", foreign)).toThrow(AnyCloudError);
    expect(() => addRole("reader", foreign)).toThrow(/engineOptions\.mariadb/);
    expect(() => addRole("reader", foreign)).toThrow(/CloudNativePG/);
  });

  it("reports UNSUPPORTED_ROLE_OPTION for a foreign engineOptions block", () => {
    const addRole = addRoleOf(makeDatabase());

    try {
      addRole("reader", { engineOptions: { mariadb: {} } });
      expect.unreachable("addRole should have thrown for engineOptions.mariadb");
    } catch (error) {
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_ROLE_OPTION);
    }
  });

  it("still accepts its own engineOptions block", () => {
    const addRole = addRoleOf(makeDatabase());

    expect(() =>
      addRole("reader", { engineOptions: { postgresql: { inRoles: ["pg_read_all_data"] } } })
    ).not.toThrow();
  });

  // A rejected call provisioned nothing, so it must not leave the role name
  // claimed — otherwise fixing the config fails with a duplicate-name error
  // about a role that was never created.
  it("leaves the role name claimable after a rejected call", () => {
    const addRole = addRoleOf(makeDatabase());

    expect(() => addRole("reader", { engineOptions: { mariadb: {} } })).toThrow(AnyCloudError);
    expect(() => addRole("reader")).not.toThrow();
  });

  // The privilege allowlist is enforced by the grant compiler, which does not
  // run until the Job is built — after the claim. A role rejected for `USAGE`
  // used to keep the name reserved, so correcting the privilege and retrying in
  // the same program run failed as a duplicate for a role that never existed.
  it("leaves the role name claimable after a rejected privilege", () => {
    const addRole = addRoleOf(makeDatabase());

    try {
      addRole("reader", { grants: [{ privileges: ["USAGE"] }] });
      expect.unreachable("addRole should have thrown for an unsupported privilege");
    } catch (error) {
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_PRIVILEGE);
    }

    expect(() => addRole("reader", { grants: [{ privileges: ["SELECT"] }] })).not.toThrow();
  });

  // An empty role name is not a creatable PostgreSQL role. Accepted, the
  // DatabaseRole CR, its Secrets and its grant Job were all registered and the
  // deploy failed inside the CNPG controller, after `pulumi up` succeeded.
  it.each(["", " "])("rejects a blank role name (%p)", (roleName) => {
    const addRole = addRoleOf(makeDatabase());

    expect(() => addRole(roleName)).toThrow(AnyCloudError);
    expect(() => addRole(roleName)).toThrow(/is empty/);
  });

  it("provisions nothing before rejecting a blank role name", async () => {
    const addRole = addRoleOf(makeDatabase());
    await settle();
    const before = [...registered];

    expect(() => addRole("")).toThrow(AnyCloudError);
    await settle();

    expect(registered).toEqual(before);
  });

  it("provisions nothing before rejecting a privilege", async () => {
    const addRole = addRoleOf(makeDatabase());
    await settle();
    const before = [...registered];

    expect(() => addRole("reader", { grants: [{ privileges: ["USAGE"] }] })).toThrow(AnyCloudError);
    await settle();

    expect(registered).toEqual(before);
  });
});
