import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const configuredContext = process.env.NIMBUS_PDB_TEST_CONTEXT;
const suite = configuredContext ? describe : describe.skip;

suite("Kubernetes PodDisruptionBudget eviction behavior", () => {
  const namespace = `nimbus-pdb-${randomUUID().slice(0, 8)}`;
  const ordinaryRequestTimeout = "10s";
  const ordinaryCommandTimeoutMs = 15_000;
  const rolloutTimeout = { requestTimeout: "130s", commandTimeoutMs: 150_000 };

  function kubectl(
    args: string[],
    input?: string,
    timeout = { requestTimeout: ordinaryRequestTimeout, commandTimeoutMs: ordinaryCommandTimeoutMs }
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(
        "kubectl",
        [
          `--request-timeout=${timeout.requestTimeout}`,
          "--context",
          configuredContext ?? "",
          "-n",
          namespace,
          ...args,
        ],
        { encoding: "utf8", timeout: timeout.commandTimeoutMs, maxBuffer: 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            Object.assign(error, { stdout, stderr });
            reject(error);
          } else {
            resolve(stdout);
          }
        }
      ).stdin?.end(input);
    });
  }

  async function apply(yaml: string): Promise<void> {
    await kubectl(["apply", "-f", "-"], yaml);
  }

  function deployment(name: string, replicas: number): string {
    return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  replicas: ${replicas}
  selector:
    matchLabels: { app: ${name} }
  template:
    metadata:
      labels: { app: ${name} }
    spec:
      containers:
        - name: pause
          image: registry.k8s.io/pause:3.10
`;
  }

  function budget(name: string, app: string, policy: string): string {
    return `apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: ${name}
spec:
  ${policy}
  selector:
    matchLabels: { app: ${app} }
`;
  }

  async function evict(name: string): Promise<{ status: number; output: string }> {
    const body = JSON.stringify({
      apiVersion: "policy/v1",
      kind: "Eviction",
      metadata: { name, namespace },
    });
    try {
      return {
        status: 0,
        output: await kubectl(
          ["create", "--raw", `/api/v1/namespaces/${namespace}/pods/${name}/eviction`, "-f", "-"],
          body
        ),
      };
    } catch (error) {
      const result = error as {
        status?: number;
        stderr?: string;
        stdout?: string;
      };
      return {
        status: result.status ?? 1,
        output: `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`,
      };
    }
  }

  async function pods(app: string): Promise<string[]> {
    const result = JSON.parse(await kubectl(["get", "pods", "-l", `app=${app}`, "-o", "json"])) as {
      items: Array<{ metadata: { name: string } }>;
    };
    return result.items.map((pod) => pod.metadata.name);
  }

  async function waitForBudget(
    name: string,
    expectedAllowed: number,
    expectedDisruptedPod?: string
  ): Promise<void> {
    const deadline = Date.now() + 120_000;
    let lastState = "PDB has not been observed";
    while (Date.now() < deadline) {
      const current = JSON.parse(await kubectl(["get", "pdb", name, "-o", "json"])) as {
        metadata: { generation?: number };
        status?: {
          observedGeneration?: number;
          disruptionsAllowed?: number;
          disruptedPods?: Record<string, unknown>;
        };
      };
      const status = current.status;
      const generation = current.metadata.generation ?? 1;
      const observed = status?.observedGeneration ?? 0;
      const allowed = status?.disruptionsAllowed ?? 0;
      const recordedDisruption = expectedDisruptedPod
        ? Object.keys(status?.disruptedPods ?? {}).includes(expectedDisruptedPod)
        : true;
      lastState = `generation=${generation}, observed=${observed}, disruptionsAllowed=${allowed}, disruptedPodRecorded=${recordedDisruption}`;
      if (observed >= generation && allowed === expectedAllowed && recordedDisruption) return;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for PDB ${name}: ${lastState}`);
  }

  beforeAll(async () => {
    await kubectl(["create", "namespace", namespace]);
  });

  afterAll(async () => {
    await kubectl(["delete", "namespace", namespace, "--wait=false", "--ignore-not-found"]).catch(
      () => undefined
    );
  });

  it("blocks a single replica, allows one of two, then allows eviction without a budget", async () => {
    await apply(deployment("singleton", 1));
    await kubectl(
      ["rollout", "status", "deployment/singleton", "--timeout=120s"],
      undefined,
      rolloutTimeout
    );
    await apply(budget("singleton-budget", "singleton", "minAvailable: 1"));
    await waitForBudget("singleton-budget", 0);
    const singleton = (await pods("singleton"))[0];
    if (!singleton) throw new Error("singleton Deployment has no pod");
    const blockedSingleton = await evict(singleton);
    expect(blockedSingleton.status).not.toBe(0);
    expect(blockedSingleton.output).toMatch(/429|Too Many Requests|disruption budget/i);

    await apply(deployment("pair", 2));
    await kubectl(
      ["rollout", "status", "deployment/pair", "--timeout=120s"],
      undefined,
      rolloutTimeout
    );
    await apply(budget("pair-budget", "pair", "maxUnavailable: 1"));
    await waitForBudget("pair-budget", 1);
    const pairPods = await pods("pair");
    expect(pairPods).toHaveLength(2);
    const [firstPairPod, secondPairPod] = pairPods;
    if (!firstPairPod || !secondPairPod) throw new Error("pair Deployment must have two pods");
    const allowedFirst = await evict(firstPairPod);
    expect(allowedFirst.status).toBe(0);
    await waitForBudget("pair-budget", 0, firstPairPod);
    const blockedSecond = await evict(secondPairPod);
    expect(blockedSecond.status).not.toBe(0);
    expect(blockedSecond.output).toMatch(/429|Too Many Requests|disruption budget/i);

    await apply(deployment("unprotected", 1));
    await kubectl(
      ["rollout", "status", "deployment/unprotected", "--timeout=120s"],
      undefined,
      rolloutTimeout
    );
    const unprotectedPod = (await pods("unprotected"))[0];
    if (!unprotectedPod) throw new Error("unprotected Deployment has no pod");
    expect((await evict(unprotectedPod)).status).toBe(0);
  }, 360_000);
});
