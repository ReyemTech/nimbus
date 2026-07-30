import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import {
  assertNoEnvironments,
  createSingleNeo4jDatabaseInstance,
} from "../../../src/operator/neo4j-database.js";
import type { IDatabaseInstance } from "../../../src/operator/interfaces.js";
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
  "shared-neo4j-graph-neo4j-password",
  "shared-neo4j-graph-neo4j-password-read",
  "neo4j-init-user-shared-neo4j-graph",
  "shared-neo4j-graph-neo4j-secret-app",
];

/** Build a database instance against mocked Pulumi resources. */
function makeDatabase(
  config: Parameters<typeof createSingleNeo4jDatabaseInstance>[0]["config"] = {
    namespaces: ["app"],
  }
): IDatabaseInstance {
  const provider = new k8s.Provider("test-provider", {});
  const release = new k8s.helm.v3.Release(
    "test-neo4j-release",
    { chart: "neo4j", namespace: "data" },
    { provider }
  );

  return createSingleNeo4jDatabaseInstance({
    clusterName: "shared-neo4j",
    dbName: "graph",
    config,
    endpoint: pulumi.output("shared-neo4j.data.svc.cluster.local"),
    port: pulumi.output(7687),
    adminSecretName: "shared-neo4j-neo4j-auth",
    release,
    provider,
  });
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

/** Read the inputs of a registered resource. */
function inputsOf(name: string): Record<string, unknown> {
  const inputs = inputsByName[name];
  if (!inputs) {
    throw new Error(`no resource named ${name} was registered`);
  }
  return inputs;
}

/** Read the `sh -c` script the provisioning Job runs. */
function jobScriptOf(name: string): string {
  const spec = inputsOf(name)["spec"] as {
    template: { spec: { containers: { command: string[] }[] } };
  };
  const command = spec.template.spec.containers[0]?.command;
  if (!command) {
    throw new Error(`Job ${name} registered no container command`);
  }
  return command[command.length - 1] ?? "";
}

describe("createSingleNeo4jDatabaseInstance", () => {
  // Pulumi identifies a resource by its logical name; renaming one deletes and
  // recreates it, and for a credential Secret that regenerates the password and
  // breaks every running application. These are the names neo4j.ts registered
  // before role provisioning was factored out. A failure here is a release
  // blocker, not a test to update.
  it.each([
    "shared-neo4j-graph-neo4j-password",
    "neo4j-init-user-shared-neo4j-graph",
    "shared-neo4j-graph-neo4j-secret-app",
  ])("registers %s under its pre-refactor logical name", async (name) => {
    makeDatabase();
    await awaitRegistered(name);

    expect(registered).toContain(name);
  });

  // The read-back is the one deliberate rename: `createRoleCredentials` derives
  // it as `{credentialResource}-read`, so it moved from `...-neo4j-user-read` to
  // `...-neo4j-password-read`. Secret.get() registers an EXTERNAL resource
  // Pulumi does not own, so dropping the old one churns state without issuing
  // any Delete against the live Secret — no alias needed.
  it("derives the read-back name from the credential resource", async () => {
    makeDatabase();
    await awaitRegistered(...OWNER_RESOURCES);

    expect(registered).toContain("shared-neo4j-graph-neo4j-password-read");
    expect(registered).not.toContain("shared-neo4j-graph-neo4j-user-read");
  });

  // The Kubernetes names are what live pods mount, and are independent of the
  // Pulumi logical names above.
  it("keeps the pre-refactor Kubernetes object names", async () => {
    makeDatabase();
    await awaitRegistered(...OWNER_RESOURCES);

    expect(inputsOf("shared-neo4j-graph-neo4j-password")["metadata"]).toMatchObject({
      name: "shared-neo4j-graph-neo4j-user",
      namespace: "data",
    });
    expect(inputsOf("neo4j-init-user-shared-neo4j-graph")["metadata"]).toMatchObject({
      name: "neo4j-init-user-shared-neo4j-graph",
    });
    expect(inputsOf("shared-neo4j-graph-neo4j-secret-app")["metadata"]).toMatchObject({
      name: "shared-neo4j-graph-neo4j",
      namespace: "app",
    });
  });

  // The owner's Secret has always held username and password; a consumer that
  // reads `username` from it must keep working.
  it("keeps username and password in the owner credential Secret", async () => {
    makeDatabase();
    await awaitRegistered("shared-neo4j-graph-neo4j-password");

    const stringData = inputsOf("shared-neo4j-graph-neo4j-password")["stringData"];
    expect(Object.keys(unwrapSecret(stringData)).sort()).toEqual(["password", "username"]);
    expect(unwrapSecret(stringData)["username"]).toBe("graph");
  });

  it("honours config.owner as the username", async () => {
    makeDatabase({ namespaces: ["app"], owner: "etl" });
    await awaitRegistered("shared-neo4j-graph-neo4j-password");

    const stringData = inputsOf("shared-neo4j-graph-neo4j-password")["stringData"];
    expect(unwrapSecret(stringData)["username"]).toBe("etl");
    expect(jobScriptOf("neo4j-init-user-shared-neo4j-graph")).toContain("CREATE USER");
  });

  // config.owner was the only way an unsafe identifier could reach the Cypher
  // statement before addRole() existed; it is validated on the same choke point.
  it("rejects a config.owner that would break out of Cypher identifier quoting", () => {
    expect(() => makeDatabase({ namespaces: ["app"], owner: "et`l" })).toThrow(AnyCloudError);
    expect(() => makeDatabase({ namespaces: ["app"], owner: "et`l" })).toThrow(/backtick/);
  });

  it("replicates a connection Secret naming the database", async () => {
    const db = makeDatabase();
    await awaitRegistered(...OWNER_RESOURCES);

    await expect(unwrap(pulumi.output(db.secrets["app"]))).resolves.toBe(
      "shared-neo4j-graph-neo4j"
    );
    expect(db.name).toBe("graph");
    expect(db.clusterName).toBe("shared-neo4j");
  });
});

// `GRANT ROLE reader, editor` is Enterprise-only, so on `neo4j:community` the
// second cypher-shell invocation always failed and `|| true` discarded the
// failure. An operation that can never be honoured must not be issued at all.
describe("provisioning Job script", () => {
  it("issues CREATE USER and nothing else", async () => {
    makeDatabase();
    await awaitRegistered("neo4j-init-user-shared-neo4j-graph");

    const script = jobScriptOf("neo4j-init-user-shared-neo4j-graph");
    expect(script).toContain("CREATE USER");
    expect(script).toContain("IF NOT EXISTS SET PLAINTEXT PASSWORD");
    expect(script).not.toContain("GRANT ROLE");
    expect(script).not.toContain("|| true");
    expect(script.match(/cypher-shell/g)).toHaveLength(1);
  });
});

// Accepting `environments` and dropping it returned one instance where the
// caller's types promised a Record keyed by environment, so `db["prod"]` was
// undefined at runtime with nothing to explain it.
describe("assertNoEnvironments", () => {
  it("rejects environments, which Neo4j cannot fan a database out across", () => {
    expect(() =>
      assertNoEnvironments("graph", {
        namespaces: ["app"],
        environments: { prod: { namespaces: ["prod"] } },
      })
    ).toThrow(AnyCloudError);
  });

  it("reports UNSUPPORTED_ROLE_OPTION and names the database", () => {
    try {
      assertNoEnvironments("graph", {
        namespaces: ["app"],
        environments: { prod: {} },
      });
      expect.unreachable("assertNoEnvironments should have thrown");
    } catch (error) {
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_ROLE_OPTION);
      expect((error as AnyCloudError).message).toContain('"graph"');
      expect((error as AnyCloudError).message).toContain("single user database");
    }
  });

  it("accepts a config without environments", () => {
    expect(() => assertNoEnvironments("graph", { namespaces: ["app"] })).not.toThrow();
  });
});

describe("addRole", () => {
  // `CREATE USER ... IF NOT EXISTS` makes a second Job for the same username a
  // silent no-op, so the role's own Secrets would hold a password that was
  // never set — credentials that never authenticate, with nothing in the Pulumi
  // diff to say why.
  it("rejects the database owner's own name", () => {
    const db = makeDatabase();

    expect(() => db.addRole("graph")).toThrow(AnyCloudError);
    expect(() => db.addRole("graph")).toThrow(/owner of database "graph"/);
    expect(() => db.addRole("graph")).toThrow(/createDatabase/);
  });

  it("compares against config.owner, not the database name", () => {
    const db = makeDatabase({ namespaces: ["app"], owner: "etl" });

    expect(() => db.addRole("etl")).toThrow(AnyCloudError);
    expect(() => db.addRole("graph")).not.toThrow();
  });

  it("reports UNSUPPORTED_ROLE_OPTION for the owner's name", () => {
    const db = makeDatabase();

    try {
      db.addRole("graph");
      expect.unreachable("addRole should have thrown for the owner's name");
    } catch (error) {
      expect(error).toBeInstanceOf(AnyCloudError);
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_ROLE_OPTION);
    }
  });

  it("provisions nothing before rejecting the owner", async () => {
    const db = makeDatabase();
    await awaitRegistered(...OWNER_RESOURCES);
    const before = [...registered];

    expect(() => db.addRole("graph")).toThrow(AnyCloudError);

    expect(registered).toEqual(before);
  });

  // Neo4j Community has no RBAC at all. Accepting `grants` so the call succeeds
  // would hand back a user with full access to the whole graph while the config
  // says it is read-only.
  it("rejects grants, which Neo4j Community cannot express", () => {
    const db = makeDatabase();
    const withGrants = { grants: [{ privileges: ["SELECT"] }] };

    expect(() => db.addRole("reader", withGrants)).toThrow(AnyCloudError);
    expect(() => db.addRole("reader", withGrants)).toThrow(/does not support declarative grants/);
    expect(() => db.addRole("reader", withGrants)).toThrow(/Neo4j Community has no RBAC/);
  });

  it("names the role and the database when rejecting grants", () => {
    const db = makeDatabase();

    try {
      db.addRole("reader", { grants: [{ privileges: ["SELECT"] }] });
      expect.unreachable("addRole should have thrown for grants");
    } catch (error) {
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_ROLE_OPTION);
      expect((error as AnyCloudError).message).toContain('"reader"');
      expect((error as AnyCloudError).message).toContain('"graph"');
    }
  });

  it("provisions nothing before rejecting grants", async () => {
    const db = makeDatabase();
    await awaitRegistered(...OWNER_RESOURCES);
    const before = [...registered];

    expect(() => db.addRole("reader", { grants: [{ privileges: ["SELECT"] }] })).toThrow(
      AnyCloudError
    );

    expect(registered).toEqual(before);
  });

  // A grant with no privileges is malformed regardless of engine, and
  // `resolveRoleConfig` validates it before the engine ever sees it — so this
  // surfaces as INVALID_GRANT rather than UNSUPPORTED_ROLE_OPTION. Both reject.
  it("propagates INVALID_GRANT for a grant with no privileges", () => {
    const db = makeDatabase();

    try {
      db.addRole("reader", { grants: [{ privileges: [] }] });
      expect.unreachable("addRole should have thrown for an empty privilege list");
    } catch (error) {
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.INVALID_GRANT);
    }
  });

  // Every Neo4j user is a login account, so silently accepting `login: false`
  // would hand back a role that can log in.
  it("rejects login: false, which Neo4j cannot express", () => {
    const db = makeDatabase();

    expect(() => db.addRole("reader", { login: false })).toThrow(AnyCloudError);
    expect(() => db.addRole("reader", { login: false })).toThrow(/login account/);
  });

  it("reports UNSUPPORTED_ROLE_OPTION for login: false", () => {
    const db = makeDatabase();

    try {
      db.addRole("reader", { login: false });
      expect.unreachable("addRole should have thrown for login: false");
    } catch (error) {
      expect((error as AnyCloudError).code).toBe(ERROR_CODES.UNSUPPORTED_ROLE_OPTION);
    }
  });

  // The role name lands between escaped backticks in the Job's Cypher
  // `CREATE USER` statement, so a backtick in it would close the identifier and
  // let the rest of the name run as Cypher.
  it("rejects a role name that would break out of Cypher identifier quoting", () => {
    const db = makeDatabase();

    expect(() => db.addRole("x` SET PASSWORD 'pwned' //")).toThrow(AnyCloudError);
    expect(() => db.addRole("x` SET PASSWORD 'pwned' //")).toThrow(/backtick/);
  });

  it("provisions nothing before rejecting an unsafe role name", async () => {
    const db = makeDatabase();
    await awaitRegistered(...OWNER_RESOURCES);
    const before = [...registered];

    expect(() => db.addRole("read`er")).toThrow(AnyCloudError);

    expect(registered).toEqual(before);
  });

  it("returns the role with its replicated Secrets", async () => {
    const db = makeDatabase();
    const role = db.addRole("reader", { namespaces: ["app"] });
    await awaitRegistered(
      "shared-neo4j-graph-role-reader-neo4j-password",
      "neo4j-init-user-shared-neo4j-graph-role-reader",
      "shared-neo4j-graph-role-reader-neo4j-secret-app"
    );

    expect(role.name).toBe("reader");
    expect(role.databaseName).toBe("graph");
    expect(role.clusterName).toBe("shared-neo4j");
    await expect(unwrap(pulumi.output(role.secrets["app"]))).resolves.toBe(
      "shared-neo4j-graph-role-reader-neo4j"
    );
  });

  // Every additional-role name carries a `-role-` segment after
  // `{cluster}-{database}`, which the owner's pinned names never have.
  it("cannot collide with the owner's pinned names", async () => {
    const db = makeDatabase();
    db.addRole("reader", { namespaces: ["app"] });
    await awaitRegistered(...OWNER_RESOURCES, "shared-neo4j-graph-role-reader-neo4j-secret-app");

    for (const ownerName of OWNER_RESOURCES) {
      expect(registered.filter((name) => name === ownerName)).toHaveLength(1);
    }
  });

  it("creates the role's account with its own cypher-shell Job", async () => {
    const db = makeDatabase();
    db.addRole("reader");
    await awaitRegistered("neo4j-init-user-shared-neo4j-graph-role-reader");

    const script = jobScriptOf("neo4j-init-user-shared-neo4j-graph-role-reader");
    expect(script).toContain("CREATE USER");
    expect(script).not.toContain("GRANT ROLE");
    expect(inputsOf("neo4j-init-user-shared-neo4j-graph-role-reader")["metadata"]).toMatchObject({
      name: "neo4j-init-user-shared-neo4j-graph-role-reader",
    });
  });

  it("stores the role's username in its credential Secret", async () => {
    const db = makeDatabase();
    db.addRole("Read_Only");
    await awaitRegistered("shared-neo4j-graph-role-read-only-neo4j-password");

    const stringData = inputsOf("shared-neo4j-graph-role-read-only-neo4j-password")["stringData"];
    expect(unwrapSecret(stringData)["username"]).toBe("Read_Only");
    expect(inputsOf("shared-neo4j-graph-role-read-only-neo4j-password")["metadata"]).toMatchObject({
      name: "shared-neo4j-graph-role-read-only-neo4j-user",
    });
  });
});
