import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const configuredContext = process.env.NIMBUS_PDB_TEST_CONTEXT;
const suite = configuredContext ? describe : describe.skip;

suite("Kubernetes PodDisruptionBudget eviction behavior", () => {
  const namespace = `nimbus-pdb-${randomUUID().slice(0, 8)}`;

  function kubectl(args: string[], input?: string): string {
    return execFileSync(
      "kubectl",
      ["--context", configuredContext ?? "", "-n", namespace, ...args],
      {
        encoding: "utf8",
        input,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
  }

  function apply(yaml: string): void {
    kubectl(["apply", "-f", "-"], yaml);
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

  function evict(name: string): { status: number; output: string } {
    const body = JSON.stringify({
      apiVersion: "policy/v1",
      kind: "Eviction",
      metadata: { name, namespace },
    });
    try {
      return {
        status: 0,
        output: kubectl(
          ["create", "--raw", `/api/v1/namespaces/${namespace}/pods/${name}/eviction`, "-f", "-"],
          body
        ),
      };
    } catch (error) {
      const result = error as {
        status?: number;
        stderr?: Buffer | string;
        stdout?: Buffer | string;
      };
      return {
        status: result.status ?? 1,
        output: `${result.stdout?.toString() ?? ""}${result.stderr?.toString() ?? ""}`,
      };
    }
  }

  function pods(app: string): string[] {
    const result = JSON.parse(kubectl(["get", "pods", "-l", `app=${app}`, "-o", "json"])) as {
      items: Array<{ metadata: { name: string } }>;
    };
    return result.items.map((pod) => pod.metadata.name);
  }

  beforeAll(() => {
    execFileSync(
      "kubectl",
      ["--context", configuredContext ?? "", "create", "namespace", namespace],
      { stdio: "pipe" }
    );
  });

  afterAll(() => {
    execFileSync(
      "kubectl",
      [
        "--context",
        configuredContext ?? "",
        "delete",
        "namespace",
        namespace,
        "--wait=false",
        "--ignore-not-found",
      ],
      {
        stdio: "ignore",
      }
    );
  });

  it("blocks a single replica, allows one of two, then allows eviction without a budget", () => {
    apply(deployment("singleton", 1));
    kubectl(["rollout", "status", "deployment/singleton", "--timeout=180s"]);
    apply(budget("singleton-budget", "singleton", "minAvailable: 1"));
    const singleton = pods("singleton")[0];
    if (!singleton) throw new Error("singleton Deployment has no pod");
    const blockedSingleton = evict(singleton);
    expect(blockedSingleton.status).not.toBe(0);
    expect(blockedSingleton.output).toMatch(/429|Too Many Requests|disruption budget/i);

    apply(deployment("pair", 2));
    kubectl(["rollout", "status", "deployment/pair", "--timeout=180s"]);
    apply(budget("pair-budget", "pair", "maxUnavailable: 1"));
    const pairPods = pods("pair");
    expect(pairPods).toHaveLength(2);
    const [firstPairPod, secondPairPod] = pairPods;
    if (!firstPairPod || !secondPairPod) throw new Error("pair Deployment must have two pods");
    expect(evict(firstPairPod).status).toBe(0);
    const blockedSecond = evict(secondPairPod);
    expect(blockedSecond.status).not.toBe(0);
    expect(blockedSecond.output).toMatch(/429|Too Many Requests|disruption budget/i);

    apply(deployment("unprotected", 1));
    kubectl(["rollout", "status", "deployment/unprotected", "--timeout=180s"]);
    const unprotectedPod = pods("unprotected")[0];
    if (!unprotectedPod) throw new Error("unprotected Deployment has no pod");
    expect(evict(unprotectedPod).status).toBe(0);
  }, 360_000);
});
