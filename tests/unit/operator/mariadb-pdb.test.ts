import { runInNewContext } from "node:vm";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { expect, it } from "vitest";
import { syncMariadbPodDisruptionBudget } from "../../../src/operator/mariadb-pdb";

it("patches the same owned MariaDB PDB when disabling then re-enabling protection", async () => {
  const name = "maria-transition";
  let script: string | undefined;
  pulumi.runtime.setMocks({
    newResource: ({ name, type, inputs }) => {
      if (type === "kubernetes:batch/v1:Job") {
        const spec = inputs.spec as { template: { spec: { containers: { command: string[] }[] } } };
        script = spec.template.spec.containers[0]?.command[2];
      }
      return { id: name, state: inputs };
    },
    call: () => ({}),
  });
  const provider = new k8s.Provider("fixture", {});
  const database = new k8s.apiextensions.CustomResource(
    name,
    {
      apiVersion: "k8s.mariadb.com/v1alpha1",
      kind: "MariaDB",
      metadata: { name, namespace: "data" },
    },
    { provider }
  );
  syncMariadbPodDisruptionBudget(name, { minAvailable: 1 }, database, provider);
  await pulumi.runtime.disconnect();
  const jobScript = script;
  if (!jobScript) throw new Error("The MariaDB reconciliation Job did not register");

  const owner = {
    uid: "mariadb-uid",
    apiVersion: "k8s.mariadb.com/v1alpha1",
    kind: "MariaDB",
    name,
    controller: true,
  };
  const metadata = { resourceVersion: "pdb-1", ownerReferences: [owner] };
  let live = { metadata, spec: { maxUnavailable: 1 } };
  let desired: { minAvailable?: number; maxUnavailable?: number } = { minAvailable: 0 };
  const patches: unknown[] = [];
  let conflict = true;
  let missing = true;
  const fetch = async (url: string, options: RequestInit): Promise<Response> => {
    if (url.endsWith(`/mariadbs/${name}`)) {
      return Response.json({
        metadata: { uid: owner.uid },
        spec: { podDisruptionBudget: desired },
      });
    }
    expect(url).toBe(
      `https://kubernetes.default.svc/apis/policy/v1/namespaces/data/poddisruptionbudgets/${name}`
    );
    if (options.method === "GET") {
      if (missing) {
        missing = false;
        return new Response(null, { status: 404 });
      }
      return Response.json(live);
    }
    expect(options.method).toBe("PATCH");
    expect(options.headers).toMatchObject({ "Content-Type": "application/merge-patch+json" });
    const patch = JSON.parse(String(options.body));
    expect(patch.metadata.resourceVersion).toBe(live.metadata.resourceVersion);
    patches.push(patch);
    if (conflict) {
      conflict = false;
      live = { ...live, metadata: { ...metadata, resourceVersion: "pdb-2" } };
      return new Response(null, { status: 409 });
    }
    const spec = Object.fromEntries(
      Object.entries(patch.spec).filter(([, value]) => value !== null)
    );
    live = { ...live, spec } as typeof live;
    return Response.json(live);
  };
  const console = {
    error: (message: string) => {
      throw new Error(message);
    },
  };
  const run = () =>
    runInNewContext(jobScript, {
      require: () => ({ readFileSync: () => "service-token" }),
      process: { env: { MARIADB_NAME: name, MARIADB_NAMESPACE: "data" } },
      setTimeout: (callback: () => void) => callback(),
      fetch,
      console,
      AbortSignal,
    });

  await run();
  expect(live.spec).toEqual({ minAvailable: 0 });
  desired = { maxUnavailable: 0 };
  await run();

  expect(live.spec).toEqual({ maxUnavailable: 0 });
  expect(live.metadata.ownerReferences).toEqual([owner]);
  expect(patches).toEqual([
    { metadata: { resourceVersion: "pdb-1" }, spec: { minAvailable: 0, maxUnavailable: null } },
    { metadata: { resourceVersion: "pdb-2" }, spec: { minAvailable: 0, maxUnavailable: null } },
    { metadata: { resourceVersion: "pdb-2" }, spec: { minAvailable: null, maxUnavailable: 0 } },
  ]);
  live = {
    ...live,
    metadata: { ...metadata, ownerReferences: [{ ...owner, uid: "foreign-uid" }] },
  };
  desired = { minAvailable: 0 };
  await expect(run()).rejects.toThrow(/owner/);
  expect(patches).toHaveLength(3);
});
