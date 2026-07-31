import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import { createSingleCnpgDatabaseInstance } from "../../../src/operator/cnpg-database.js";
import { createCnpgRoleRegistry } from "../../../src/operator/cnpg-common.js";
import type { IRoleRegistry } from "../../../src/operator/role-registry.js";
import type { IGrantJobOptions } from "../../../src/operator/grants/postgres-job.js";
import type {
  IDatabaseInstance,
  IDatabaseRole,
  IDatabaseRoleConfig,
} from "../../../src/operator/interfaces.js";

/**
 * One recorded call to the grant-Job factory.
 *
 * Pulumi's test mocks never surface `dependsOn` — {@link pulumi.runtime.MockResourceArgs}
 * carries only type, name, and inputs — so the ordering edges this suite is
 * about are invisible from there. They are captured at the module boundary
 * instead, which is where `cnpg-database.ts` declares them.
 */
interface IRecordedGrantJob {
  readonly databaseName: string;
  readonly roleName: string;
  readonly dependsOn: ReadonlyArray<pulumi.Resource>;
  readonly job: k8s.batch.v1.Job | undefined;
}

const recorder = vi.hoisted(() => ({ calls: [] as IRecordedGrantJob[] }));

vi.mock("../../../src/operator/grants/postgres-job.js", async () => {
  const kubernetes = await import("@pulumi/kubernetes");

  return {
    createPostgresGrantJob(options: IGrantJobOptions): k8s.batch.v1.Job | undefined {
      // Mirrors the real "nothing to reconcile" short-circuit, because whether
      // a Job exists at all is exactly what decides where the chain continues.
      const extraSql = options.extraSql ?? [];
      if (options.grants === undefined && extraSql.length === 0) {
        recorder.calls.push({
          databaseName: options.databaseName,
          roleName: options.roleName,
          dependsOn: [...options.dependsOn],
          job: undefined,
        });
        return undefined;
      }

      const name = `stub-grant-job-${recorder.calls.length}`;
      const job = new kubernetes.batch.v1.Job(
        name,
        { metadata: { name, namespace: options.namespace } },
        { provider: options.provider, dependsOn: [...options.dependsOn] }
      );

      recorder.calls.push({
        databaseName: options.databaseName,
        roleName: options.roleName,
        dependsOn: [...options.dependsOn],
        job,
      });
      return job;
    },
  };
});

beforeAll(() => {
  pulumi.runtime.setMocks({
    newResource: (args: pulumi.runtime.MockResourceArgs) => ({
      id: `${args.name}-id`,
      state: { ...args.inputs, data: {} },
    }),
    call: () => ({}),
  });
});

beforeEach(() => {
  recorder.calls = [];
});

/** Build a database instance against mocked Pulumi resources. */
function makeDatabase(
  config: Parameters<typeof createSingleCnpgDatabaseInstance>[0]["config"] = {
    namespaces: ["app"],
    owner: "etl",
  },
  dbName = "analytics",
  roleRegistry: IRoleRegistry = createCnpgRoleRegistry("shared-pg")
): IDatabaseInstance {
  const provider = new k8s.Provider(`test-provider-${dbName}`, {});
  const cluster = new k8s.apiextensions.CustomResource(
    `test-cluster-${dbName}`,
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

/** The recorded call for a role, which must exist. */
function callFor(roleName: string): IRecordedGrantJob {
  const call = recorder.calls.find((entry) => entry.roleName === roleName);
  if (!call) {
    throw new Error(`no grant Job call was recorded for role "${roleName}"`);
  }
  return call;
}

/** The Job created for a role, which must exist. */
function jobFor(roleName: string): k8s.batch.v1.Job {
  const { job } = callFor(roleName);
  if (!job) {
    throw new Error(`the grant Job for role "${roleName}" was not created`);
  }
  return job;
}

/** Grants used wherever the specific privileges do not matter. */
const READ_GRANTS: IDatabaseRoleConfig = {
  namespaces: ["app"],
  grants: [{ privileges: ["SELECT"], schema: "marts" }],
};

// Every grant script revokes and re-grants across all of one database's schemas
// inside a single transaction. Two of them running at once contend for the same
// catalog rows and one can abort with `tuple concurrently updated` — and because
// the Job name is content-addressed, a Job that exhausts its backoffLimit is
// never retried by a later `pulumi up`. A transient collision therefore becomes
// a permanent failure needing `kubectl delete job`. Chaining each Job to the
// previous one for the same database is what prevents the collision.
describe("grant Job serialization within a database", () => {
  it("chains a second role's Job to the first role's", () => {
    const addRole = addRoleOf(makeDatabase());
    addRole("reader", READ_GRANTS);
    addRole("writer", READ_GRANTS);

    expect(callFor("writer").dependsOn).toContain(jobFor("reader"));
  });

  it("chains every Job in a straight line, not all to the first", () => {
    const addRole = addRoleOf(makeDatabase());
    addRole("reader", READ_GRANTS);
    addRole("writer", READ_GRANTS);
    addRole("auditor", READ_GRANTS);

    expect(callFor("writer").dependsOn).toContain(jobFor("reader"));
    expect(callFor("auditor").dependsOn).toContain(jobFor("writer"));
    // The third waits on the second, which already waits on the first — adding
    // the first as well would be redundant, and pinning it here keeps the chain
    // linear rather than fanning out.
    expect(callFor("auditor").dependsOn).not.toContain(jobFor("reader"));
  });

  // `config.sql` produces an owner-scoped Job against the same database, in the
  // same transaction-shaped script. It is the head of the chain, not a peer
  // running alongside the first role's grants.
  it("chains the first role's Job to the owner's config.sql Job", () => {
    const db = makeDatabase({
      namespaces: ["app"],
      owner: "etl",
      sql: ["CREATE EXTENSION IF NOT EXISTS pgcrypto;"],
    });
    addRoleOf(db)("reader", READ_GRANTS);

    expect(callFor("reader").dependsOn).toContain(jobFor("etl"));
  });

  // Omitting `grants` means privileges are unmanaged, so no Job exists to wait
  // on. The chain must skip the gap rather than break at it — otherwise the two
  // Jobs on either side of an unmanaged role run concurrently again.
  it("skips a role that produces no Job without breaking the chain", () => {
    const addRole = addRoleOf(makeDatabase());
    addRole("reader", READ_GRANTS);
    addRole("unmanaged", { namespaces: ["app"] });
    addRole("writer", READ_GRANTS);

    expect(callFor("unmanaged").job).toBeUndefined();
    expect(callFor("writer").dependsOn).toContain(jobFor("reader"));
  });

  // Nothing to wait on: the first Job for a database with no `config.sql` must
  // not be given a phantom dependency.
  it("leaves the first Job of a database unchained", () => {
    addRoleOf(makeDatabase())("reader", READ_GRANTS);

    const { dependsOn } = callFor("reader");

    expect(dependsOn.some((resource) => resource instanceof k8s.batch.v1.Job)).toBe(false);
  });
});

// Separate databases are separate transactions against separate catalogs, so
// their grant Jobs cannot contend. Chaining them anyway would serialize an
// entire cluster's reconciliation behind one slow Job for no benefit.
describe("grant Jobs across databases", () => {
  it("does not chain a Job to another database's Job", () => {
    const registry = createCnpgRoleRegistry("shared-pg");
    const billing = addRoleOf(makeDatabase({ namespaces: ["app"] }, "billing", registry));
    const analytics = addRoleOf(makeDatabase({ namespaces: ["app"] }, "analytics", registry));

    billing("billing-reader", READ_GRANTS);
    analytics("analytics-reader", READ_GRANTS);

    expect(callFor("analytics-reader").dependsOn).not.toContain(jobFor("billing-reader"));
  });

  it("still chains within each database independently", () => {
    const registry = createCnpgRoleRegistry("shared-pg");
    const billing = addRoleOf(makeDatabase({ namespaces: ["app"] }, "billing", registry));
    const analytics = addRoleOf(makeDatabase({ namespaces: ["app"] }, "analytics", registry));

    billing("billing-reader", READ_GRANTS);
    analytics("analytics-reader", READ_GRANTS);
    billing("billing-writer", READ_GRANTS);
    analytics("analytics-writer", READ_GRANTS);

    expect(callFor("billing-writer").dependsOn).toContain(jobFor("billing-reader"));
    expect(callFor("billing-writer").dependsOn).not.toContain(jobFor("analytics-reader"));
    expect(callFor("analytics-writer").dependsOn).toContain(jobFor("analytics-reader"));
    expect(callFor("analytics-writer").dependsOn).not.toContain(jobFor("billing-reader"));
  });
});
