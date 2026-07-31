import * as crypto from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { createPostgresGrantJob } from "../../../src/operator/grants/postgres-job.js";
import { compileGrantSql } from "../../../src/operator/grants/postgres-sql.js";
import type { IDatabaseGrant } from "../../../src/operator/interfaces.js";

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

/** The container's `valueFrom` shape, narrowed to the one key this module uses. */
interface ISecretKeyRef {
  readonly name: string;
  readonly key: string;
}

/** One entry of the psql container's `env`. */
interface IEnvVar {
  readonly name: string;
  readonly value?: string;
  readonly valueFrom?: { readonly secretKeyRef?: ISecretKeyRef };
}

/** The subset of the psql container this suite asserts against. */
interface IPsqlContainer {
  readonly name: string;
  readonly image: string;
  readonly command: ReadonlyArray<string>;
  readonly env: ReadonlyArray<IEnvVar>;
  readonly volumeMounts: ReadonlyArray<{ readonly name: string; readonly mountPath: string }>;
}

/** A grant spec used wherever the specific privileges do not matter. */
const READ_GRANTS: ReadonlyArray<IDatabaseGrant> = [
  { privileges: ["SELECT"], schema: "marts", objects: "all" },
];

/** Options {@link createJob} applies unless a test overrides them. */
const DEFAULT_OPTIONS = {
  clusterName: "shared-pg",
  databaseName: "analytics",
  roleName: "reader",
  ownerName: "etl",
  ownerSecretName: "shared-pg-analytics-user",
  namespace: "data",
  pgVersion: "17",
  labels: { "app.kubernetes.io/managed-by": "nimbus" },
} as const;

/** Overridable slice of {@link createPostgresGrantJob}'s options. */
type JobOverrides = Partial<{
  clusterName: string;
  databaseName: string;
  roleName: string;
  ownerName: string;
  ownerSecretName: string;
  namespace: string;
  pgVersion: string;
  grants: ReadonlyArray<IDatabaseGrant>;
  extraSql: ReadonlyArray<string>;
}>;

/** Create a grant Job against mocked Pulumi resources. */
function createJob(overrides: JobOverrides = {}): k8s.batch.v1.Job | undefined {
  const provider = new k8s.Provider(`test-provider-${registered.length}`, {});

  return createPostgresGrantJob({
    ...DEFAULT_OPTIONS,
    grants: READ_GRANTS,
    ...overrides,
    endpoint: pulumi.output("shared-pg-rw.data.svc.cluster.local"),
    labels: { ...DEFAULT_OPTIONS.labels },
    provider,
    dependsOn: [],
  });
}

/** Logical names of every grant Job registered so far (excluding its ConfigMap). */
function jobNames(): string[] {
  return registered.filter((name) => name.startsWith("cnpg-grants-") && !name.endsWith("-sql"));
}

/** The single grant Job registered by the test, by logical name. */
function soleJobName(): string {
  const names = jobNames();
  if (names.length !== 1) {
    throw new Error(`expected exactly one grant Job, found ${names.length}: ${names.join(", ")}`);
  }
  return names[0] as string;
}

/** Read a nested value off a registered resource's inputs. */
function inputsOf(name: string): Record<string, unknown> {
  const inputs = inputsByName[name];
  if (!inputs) {
    throw new Error(`no resource named ${name} was registered`);
  }
  return inputs;
}

/** The psql container of the sole registered grant Job. */
function psqlContainer(): IPsqlContainer {
  const spec = inputsOf(soleJobName())["spec"] as {
    readonly template: { readonly spec: { readonly containers: ReadonlyArray<IPsqlContainer> } };
  };
  const container = spec.template.spec.containers[0];
  if (!container) {
    throw new Error("the grant Job's Pod template declared no container");
  }
  return container;
}

/** One environment variable of the psql container. */
function envVar(name: string): IEnvVar {
  const found = psqlContainer().env.find((entry) => entry.name === name);
  if (!found) {
    throw new Error(`the psql container declares no ${name}`);
  }
  return found;
}

/** The SQL the Job's ConfigMap mounts. */
function mountedSql(): string {
  const data = inputsOf(`${soleJobName()}-sql`)["data"] as Record<string, string> | undefined;
  const sql = data?.["grants.sql"];
  if (!sql) {
    throw new Error("the grant Job's ConfigMap mounted no SQL under grants.sql");
  }
  return sql;
}

/** RFC 1123 label: what Kubernetes enforces on `metadata.name` for a Job. */
const DNS_1123_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
/** Longest `metadata.name` Kubernetes accepts for a Job. */
const DNS_1123_LABEL_MAX_LENGTH = 63;

describe("createPostgresGrantJob", () => {
  // Nothing to reconcile: `grants` omitted means privileges are not managed for
  // this role at all, so there is no Job and no ConfigMap.
  it("creates nothing when grants and extraSql are both absent", async () => {
    expect(createJob({ grants: undefined })).toBeUndefined();
    await settle();

    expect(jobNames()).toEqual([]);
  });

  // `grants: []` is a real reconciliation ("this role holds nothing"), not a
  // no-op — the compiled script is revoke-only and must still run.
  it("creates a revoke-only Job for an empty grants list", async () => {
    expect(createJob({ grants: [] })).toBeDefined();
    await settle();

    expect(jobNames()).toHaveLength(1);
    expect(mountedSql()).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA");
  });

  it("creates a Job for extraSql alone", async () => {
    expect(
      createJob({ grants: undefined, extraSql: ["CREATE EXTENSION IF NOT EXISTS x;"] })
    ).toBeDefined();
    await settle();

    expect(mountedSql()).toContain("CREATE EXTENSION IF NOT EXISTS x;");
  });
});

// Every assertion below is a promise the module's docblock makes about what
// actually runs against a production database. They are separated from the
// shape tests because a regression in any of them is a security regression,
// not a cosmetic one.
describe("grant Job security invariants", () => {
  // The whole point of this Job is that grants are applied by the database
  // OWNER. Authenticating as `postgres` would hand every grant script
  // superuser rights over the entire cluster, including databases it has no
  // business touching, and would make the owner's own ACLs irrelevant.
  it("authenticates as the database owner, never as a superuser", async () => {
    createJob({ ownerName: "etl" });
    await settle();

    expect(envVar("PGUSER").value).toBe("etl");
    expect(envVar("PGUSER").value).not.toBe("postgres");
  });

  it("tracks the owner name it was given rather than a hardcoded role", async () => {
    createJob({ ownerName: "warehouse-owner" });
    await settle();

    expect(envVar("PGUSER").value).toBe("warehouse-owner");
  });

  // The password is read from the owner's existing Secret at Pod start. Pointing
  // `secretKeyRef` at the wrong Secret or the wrong key makes the Job
  // authenticate with an empty password — or, worse, with another role's.
  it("reads the password from the owner Secret's password key", async () => {
    createJob({ ownerSecretName: "shared-pg-analytics-user" });
    await settle();

    const ref = envVar("PGPASSWORD").valueFrom?.secretKeyRef;

    expect(ref).toEqual({ name: "shared-pg-analytics-user", key: "password" });
    // The password must never be inlined as a literal env value.
    expect(envVar("PGPASSWORD").value).toBeUndefined();
  });

  // Credentials and the whole grant script cross the pod network. `disable`
  // would put both on the wire in plaintext; `require` is the floor.
  it("requires TLS on the connection", async () => {
    createJob();
    await settle();

    expect(envVar("PGSSLMODE").value).toBe("require");
    expect(envVar("PGSSLMODE").value).not.toBe("disable");
  });

  // The SQL is assembled from role names, schema names, and grant data — all
  // user-controlled. Passing it as `-c <sql>` would put every one of those
  // strings into argv, where they are visible in `kubectl describe`, in the Pod
  // spec stored in etcd, and to anything that can read the container's cmdline.
  // Mounting a ConfigMap keeps them out of the process arguments entirely.
  it("passes the SQL by mounted file, never inline in argv", async () => {
    createJob({ grants: [{ privileges: ["SELECT"], schema: "marts", objects: "orders" }] });
    await settle();

    const container = psqlContainer();

    expect(container.command).toEqual(["psql", "-v", "ON_ERROR_STOP=1", "-f", "/sql/grants.sql"]);
    expect(container.command).not.toContain("-c");
    // No fragment of the compiled script may appear in the arguments.
    expect(container.command.some((arg) => arg.includes("GRANT"))).toBe(false);
    expect(container.command.some((arg) => arg.includes("marts"))).toBe(false);
  });

  // Without ON_ERROR_STOP, psql reports success after a script whose statements
  // all failed: the Job goes green and the role silently holds nothing (or
  // still holds everything it was meant to lose).
  it("stops on the first failing statement", async () => {
    createJob();
    await settle();

    expect(psqlContainer().command).toContain("ON_ERROR_STOP=1");
  });

  // The mounted path must agree with the volume mount and the ConfigMap key, or
  // psql reads nothing and — with ON_ERROR_STOP — fails the Job.
  it("mounts the ConfigMap at the path psql reads", async () => {
    createJob();
    await settle();

    const jobName = soleJobName();
    const container = psqlContainer();

    expect(container.volumeMounts).toEqual([{ name: "sql", mountPath: "/sql" }]);
    expect(container.command.at(-1)).toBe("/sql/grants.sql");

    const spec = inputsOf(jobName)["spec"] as {
      readonly template: {
        readonly spec: {
          readonly volumes: ReadonlyArray<{ readonly configMap?: { readonly name: string } }>;
        };
      };
    };
    expect(spec.template.spec.volumes[0]?.configMap?.name).toBe(`${jobName}-sql`);
    expect(inputsOf(`${jobName}-sql`)["data"]).toHaveProperty("grants.sql");
  });

  it("connects to the database it was asked to reconcile", async () => {
    createJob({ databaseName: "billing" });
    await settle();

    expect(envVar("PGDATABASE").value).toBe("billing");
    expect(envVar("PGHOST").value).toBe("shared-pg-rw.data.svc.cluster.local");
  });

  it("mounts exactly the SQL the compiler produced", async () => {
    createJob({ grants: READ_GRANTS, extraSql: ["ANALYZE;"] });
    await settle();

    expect(mountedSql()).toBe(
      compileGrantSql({
        role: DEFAULT_OPTIONS.roleName,
        owner: DEFAULT_OPTIONS.ownerName,
        grants: READ_GRANTS,
        extraSql: ["ANALYZE;"],
      })
    );
  });
});

describe("grant Job naming", () => {
  /** Recompute the identity the Job name's checksum must be taken over. */
  function expectedChecksum(
    clusterName: string,
    databaseName: string,
    roleName: string,
    sql: string
  ): string {
    return crypto
      .createHash("sha256")
      .update([clusterName, databaseName, roleName, sql].join("\n"))
      .digest("hex")
      .slice(0, 8);
  }

  // The checksum is what makes an unchanged spec a Pulumi no-op and a changed
  // one a Job that actually runs. It must cover the resource identity as well
  // as the SQL, because the compiled SQL does not encode the cluster or the
  // database at all.
  it("checksums cluster, database, role, and SQL together", async () => {
    createJob();
    await settle();

    const sql = compileGrantSql({
      role: DEFAULT_OPTIONS.roleName,
      owner: DEFAULT_OPTIONS.ownerName,
      grants: READ_GRANTS,
      extraSql: [],
    });

    expect(soleJobName()).toBe(
      "cnpg-grants-shared-pg-analytics-reader-" +
        expectedChecksum("shared-pg", "analytics", "reader", sql)
    );
  });

  // The collision the identity checksum exists to prevent. Two databases on one
  // cluster with the same role name and the same grants compile to
  // byte-identical SQL, and with names long enough that truncation removes the
  // part that distinguishes them, the descriptive prefix is identical too. Only
  // the database name being inside the checksum keeps the two Jobs apart —
  // without it they share a name, and the second database's grants never run.
  it("distinguishes two databases whose descriptive prefixes truncate alike", async () => {
    const clusterName = "shared-postgres-cluster-primary";
    createJob({ clusterName, databaseName: "analytics-warehouse-a" });
    createJob({ clusterName, databaseName: "analytics-warehouse-b" });
    await settle();

    const names = jobNames();

    expect(names).toHaveLength(2);
    // Precondition: the descriptive halves really are indistinguishable.
    expect(names[0]?.slice(0, -9)).toBe(names[1]?.slice(0, -9));
    expect(names[0]).not.toBe(names[1]);
  });

  // Same collision one level up: the cluster name never appears in the compiled
  // SQL, so two clusters whose names truncate alike depend entirely on the
  // checksum covering `clusterName`.
  it("distinguishes two clusters whose descriptive prefixes truncate alike", async () => {
    const stem = `pg-cluster-${"x".repeat(40)}`;
    createJob({ clusterName: `${stem}a` });
    createJob({ clusterName: `${stem}b` });
    await settle();

    const names = jobNames();

    expect(names).toHaveLength(2);
    expect(names[0]?.slice(0, -9)).toBe(names[1]?.slice(0, -9));
    expect(names[0]).not.toBe(names[1]);
  });

  // A changed grant spec must produce a new Job, or the change never runs.
  it("changes the name when the grants change", async () => {
    createJob({ grants: [{ privileges: ["SELECT"], schema: "marts" }] });
    createJob({ grants: [{ privileges: ["SELECT", "INSERT"], schema: "marts" }] });
    await settle();

    const names = jobNames();

    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
  });

  // Cluster, database, and role names are user-controlled and unbounded. A Job
  // stamps its own name onto the `job-name` label of every Pod it creates, and
  // label values are capped at 63 characters — so an untruncated name is
  // rejected by the API server and no grant is ever applied.
  it("truncates a long name to a valid DNS-1123 label", async () => {
    createJob({
      clusterName: "production-postgresql-cluster-eu-central-1",
      databaseName: "customer-analytics-warehouse-primary",
      roleName: "reporting-read-only-service-account",
    });
    await settle();

    const jobName = soleJobName();
    const configMapName = `${jobName}-sql`;

    expect(jobName).toMatch(DNS_1123_LABEL);
    expect(configMapName).toMatch(DNS_1123_LABEL);
    // The ConfigMap's name is the Job's name plus "-sql", so the Job's own
    // budget is four characters short of the label limit.
    expect(configMapName.length).toBeLessThanOrEqual(DNS_1123_LABEL_MAX_LENGTH);
    expect(jobName.length).toBeLessThanOrEqual(DNS_1123_LABEL_MAX_LENGTH - "-sql".length);
    // Truncation must never eat the checksum.
    expect(jobName).toMatch(/-[0-9a-f]{8}$/);
  });

  it("sanitizes characters a DNS-1123 label cannot carry", async () => {
    createJob({ roleName: "Read_Only@Corp" });
    await settle();

    expect(soleJobName()).toMatch(DNS_1123_LABEL);
    expect(soleJobName()).toContain("read-only-corp");
  });

  it("names the Kubernetes objects after the derived logical name", async () => {
    createJob();
    await settle();

    const jobName = soleJobName();
    const metadata = inputsOf(jobName)["metadata"] as Record<string, unknown>;

    expect(metadata["name"]).toBe(jobName);
    expect(metadata["namespace"]).toBe("data");
    expect(inputsOf(`${jobName}-sql`)["metadata"]).toMatchObject({
      name: `${jobName}-sql`,
      namespace: "data",
    });
  });
});

describe("grant Job pod policy", () => {
  it("never restarts a failed pod in place and bounds its retries", async () => {
    createJob();
    await settle();

    const spec = inputsOf(soleJobName())["spec"] as Record<string, unknown>;

    expect(spec["backoffLimit"]).toBe(5);
    expect(spec["ttlSecondsAfterFinished"]).toBe(300);
    expect((spec["template"] as { spec: { restartPolicy: string } }).spec.restartPolicy).toBe(
      "Never"
    );
  });

  it("selects the psql image for the cluster's major version", async () => {
    createJob({ pgVersion: "16" });
    await settle();

    expect(psqlContainer().image).toBe("ghcr.io/cloudnative-pg/postgresql:16");
  });
});
