import { beforeEach, describe, expect, it } from "vitest";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { ICluster } from "../../../src/cluster";
import { createOperator } from "../../../src/operator";
import type { IOperatorConfig } from "../../../src/operator";

const HELM_RELEASE = "kubernetes:helm.sh/v3:Release";
const PDB = "kubernetes:policy/v1:PodDisruptionBudget";
const resources: pulumi.runtime.MockResourceArgs[] = [];
let provider: k8s.Provider;

beforeEach(() => {
  resources.length = 0;
  pulumi.runtime.setMocks({
    newResource: (args) => {
      resources.push(args);
      return {
        id: args.name,
        state:
          args.type === HELM_RELEASE
            ? { ...args.inputs, name: `${args.name}-actual` }
            : args.inputs,
      };
    },
    call: () => ({}),
  });
  provider = new k8s.Provider("test-operator-availability", {});
});

function config(availability: Omit<IOperatorConfig, "cluster"> = {}): IOperatorConfig {
  return { cluster: { provider } as ICluster, ...availability };
}

function inputs(name: string, type?: string): Record<string, unknown> | undefined {
  return resources.find((resource) => resource.name === name && (!type || resource.type === type))
    ?.inputs;
}

function budgets(): string[] {
  return resources
    .filter(({ type }) => type === PDB || type === `${PDB}Patch`)
    .map(({ name }) => name)
    .sort();
}

describe("database operator controllers", () => {
  it("uses the CNPG chart's placement values and release-specific PDB selector", async () => {
    createOperator(
      "cloudnative-pg",
      config({
        version: "0.29.0",
        values: {
          nameOverride: "custom-cnpg",
          namespaceOverride: "custom-system",
          priorityClassName: "high",
        },
        scheduling: { replicas: 2, spread: { strategy: "topology-spread", mode: "required" } },
      })
    );
    await pulumi.runtime.disconnect();

    expect(inputs("cloudnative-pg-operator", HELM_RELEASE)?.values).toMatchObject({
      replicaCount: 2,
      priorityClassName: "high",
      topologySpreadConstraints: [
        {
          maxSkew: 1,
          topologyKey: "kubernetes.io/hostname",
          whenUnsatisfiable: "DoNotSchedule",
          labelSelector: { matchLabels: { "app.kubernetes.io/name": "custom-cnpg" } },
          matchLabelKeys: ["app.kubernetes.io/instance"],
        },
      ],
    });
    expect(inputs("cloudnative-pg-operator-pdb", PDB)).toMatchObject({
      metadata: { namespace: "custom-system" },
      spec: {
        maxUnavailable: 1,
        selector: {
          matchLabels: {
            "app.kubernetes.io/name": "custom-cnpg",
            "app.kubernetes.io/instance": "cloudnative-pg-operator-actual",
          },
        },
      },
    });
  });

  it("uses the MariaDB chart's native maxUnavailable, HA, and affinity values", async () => {
    createOperator(
      "mariadb-operator",
      config({
        scheduling: { replicas: 3, spread: { mode: "required" } },
        podDisruptionBudget: { maxUnavailable: "50%" },
      })
    );
    await pulumi.runtime.disconnect();

    expect(inputs("mariadb-operator-operator", HELM_RELEASE)?.values).toMatchObject({
      ha: { enabled: true, replicas: 3 },
      pdb: { enabled: true, maxUnavailable: "50%" },
      affinity: {
        podAntiAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: [
            {
              topologyKey: "kubernetes.io/hostname",
              labelSelector: { matchLabels: { "app.kubernetes.io/name": "mariadb-operator" } },
              matchLabelKeys: ["app.kubernetes.io/instance"],
            },
          ],
        },
      },
    });
    expect(budgets()).toEqual([]);
  });

  it.each([
    [undefined, undefined, { enabled: true, maxUnavailable: 0 }],
    [3, { minAvailable: 2 }, { enabled: true, maxUnavailable: 1 }],
    [3, { enabled: false }, { enabled: false }],
    [3, { minAvailable: "100%" }, { enabled: true, maxUnavailable: 0 }],
    [3, { minAvailable: "0%" }, { enabled: true, maxUnavailable: "100%" }],
  ] as const)(
    "keeps the MariaDB controller budget Helm-owned with %s replicas",
    async (replicas, policy, expected) => {
      createOperator(
        "mariadb-operator",
        config({
          scheduling: { replicas },
          podDisruptionBudget: policy,
        })
      );
      await pulumi.runtime.disconnect();

      expect(inputs("mariadb-operator-operator", HELM_RELEASE)?.values).toMatchObject({
        pdb: expected,
      });
      expect(budgets()).toEqual([]);
    }
  );

  it("rejects MariaDB controller minima that the chart cannot represent", async () => {
    for (const minAvailable of ["50%", 2]) {
      expect(() =>
        createOperator("mariadb-operator", config({ podDisruptionBudget: { minAvailable } }))
      ).toThrow(/MariaDB.*minAvailable/);
    }
    await pulumi.runtime.disconnect();
  });

  it("accepts equivalent numeric and string Helm replica values", async () => {
    createOperator(
      "cloudnative-pg",
      config({ scheduling: { replicas: 2 }, values: { replicaCount: "2" } })
    );
    await pulumi.runtime.disconnect();

    expect(inputs("cloudnative-pg-operator", HELM_RELEASE)?.values).toMatchObject({
      replicaCount: 2,
    });
  });

  it("uses MinIO chart operator values and preserves the default replica count", async () => {
    createOperator(
      "minio",
      config({
        values: { operator: { priorityClassName: "high", affinity: { nodeAffinity: {} } } },
        scheduling: { spread: { strategy: "topology-spread" } },
      })
    );
    await pulumi.runtime.disconnect();

    expect(inputs("minio-operator", HELM_RELEASE)?.values).toMatchObject({
      operator: {
        priorityClassName: "high",
        affinity: { nodeAffinity: {}, podAntiAffinity: null },
        topologySpreadConstraints: [{ whenUnsatisfiable: "ScheduleAnyway" }],
      },
    });
    expect(inputs("minio-operator-pdb", PDB)?.spec).toEqual({
      maxUnavailable: 1,
      selector: {
        matchLabels: {
          "app.kubernetes.io/name": "operator",
          "app.kubernetes.io/instance": "minio-operator-actual",
        },
      },
    });
  });

  it("respects a MinIO controller replica override independently of the pool", async () => {
    createOperator(
      "minio",
      config({
        scheduling: { replicas: 1 },
        tenant: { podDisruptionBudget: { enabled: false } },
      })
    );
    await pulumi.runtime.disconnect();

    expect(inputs("minio-operator", HELM_RELEASE)?.values).toMatchObject({
      operator: { replicaCount: 1 },
    });
    expect(inputs("minio-operator-pdb", PDB)?.spec).toMatchObject({ minAvailable: 1 });
    expect(budgets()).toEqual(["minio-operator-pdb"]);
  });

  it("rejects conflicting controller settings in raw Helm values", async () => {
    expect(() =>
      createOperator(
        "minio",
        config({
          scheduling: { replicas: 2 },
          values: { operator: { replicaCount: 3 } },
        })
      )
    ).toThrow(/operator\.replicaCount/);
    await pulumi.runtime.disconnect();
  });
});

describe("database workload availability", () => {
  it("serializes the native CNPG budget switch and affinity without a second PDB", async () => {
    const operator = createOperator(
      "cloudnative-pg",
      config({ podDisruptionBudget: { enabled: false } })
    );
    operator.createCluster("pg-test", {
      replicas: 3,
      podDisruptionBudget: { enabled: false },
      scheduling: { spread: { topologyKey: "kubernetes.io/hostname", mode: "required" } },
    });
    await pulumi.runtime.disconnect();

    expect(inputs("pg-test-cnpg-cluster")?.spec).toMatchObject({
      instances: 3,
      enablePDB: false,
      affinity: {
        enablePodAntiAffinity: true,
        topologyKey: "kubernetes.io/hostname",
        podAntiAffinityType: "required",
      },
    });
    expect(budgets()).toEqual([]);
  });

  it("rejects numerical CNPG workload budgets because the API only exposes enablePDB", async () => {
    const operator = createOperator("cloudnative-pg", config());
    expect(() =>
      operator.createCluster("pg-limits", { podDisruptionBudget: { maxUnavailable: 1 } })
    ).toThrow(/enablePDB/);
    await pulumi.runtime.disconnect();
  });

  it("serializes MariaDB's native budget and affinity without a second PDB", async () => {
    const operator = createOperator(
      "mariadb-operator",
      config({ podDisruptionBudget: { enabled: false } })
    );
    operator.createCluster("maria-test", {
      replicas: 3,
      scheduling: { spread: { mode: "required" } },
    });
    await pulumi.runtime.disconnect();

    expect(inputs("maria-test-mariadb")?.spec).toMatchObject({
      podDisruptionBudget: { maxUnavailable: 1 },
      affinity: {
        podAntiAffinity: {
          requiredDuringSchedulingIgnoredDuringExecution: [
            {
              topologyKey: "kubernetes.io/hostname",
              labelSelector: {
                matchLabels: {
                  "app.kubernetes.io/name": "mariadb",
                  "app.kubernetes.io/instance": "maria-test",
                },
              },
            },
          ],
        },
      },
    });
    expect(inputs("maria-test-mariadb")?.spec).not.toHaveProperty("affinity.antiAffinityEnabled");
    expect(inputs("maria-test-mariadb-pdb-sync-role")?.rules).toEqual([
      {
        apiGroups: ["policy"],
        resources: ["poddisruptionbudgets"],
        resourceNames: ["maria-test"],
        verbs: ["get", "patch"],
      },
      {
        apiGroups: ["k8s.mariadb.com"],
        resources: ["mariadbs"],
        resourceNames: ["maria-test"],
        verbs: ["get"],
      },
    ]);
    expect(inputs("maria-test-mariadb-pdb-sync")?.spec).toMatchObject({
      activeDeadlineSeconds: 300,
      backoffLimit: 0,
      template: { metadata: { annotations: { "nimbus/pdb-policy": '{"maxUnavailable":1}' } } },
    });
    expect(budgets()).toEqual([]);
  });

  it("requests an unrestricted MariaDB PDB when workload protection is disabled", async () => {
    const operator = createOperator(
      "mariadb-operator",
      config({ podDisruptionBudget: { enabled: false } })
    );
    operator.createCluster("maria-disable", {
      replicas: 2,
      podDisruptionBudget: { enabled: false },
    });
    await pulumi.runtime.disconnect();

    expect(inputs("maria-disable-mariadb")?.spec).toMatchObject({
      podDisruptionBudget: { minAvailable: 0 },
    });
    expect(inputs("maria-disable-mariadb-pdb-sync")?.spec).toMatchObject({
      template: { metadata: { annotations: { "nimbus/pdb-policy": '{"minAvailable":0}' } } },
    });
    expect(budgets()).toEqual([]);
  });

  it("uses explicit podAntiAffinity for MariaDB preferred placement", async () => {
    createOperator("mariadb-operator", config()).createCluster("maria-preferred", {
      scheduling: { spread: { mode: "preferred" } },
    });
    await pulumi.runtime.disconnect();

    expect(inputs("maria-preferred-mariadb")?.spec).toMatchObject({
      affinity: {
        podAntiAffinity: {
          preferredDuringSchedulingIgnoredDuringExecution: [
            {
              weight: 100,
              podAffinityTerm: {
                labelSelector: {
                  matchLabels: {
                    "app.kubernetes.io/name": "mariadb",
                    "app.kubernetes.io/instance": "maria-preferred",
                  },
                },
              },
            },
          ],
        },
      },
    });
    expect(inputs("maria-preferred-mariadb")?.spec).not.toHaveProperty(
      "affinity.antiAffinityEnabled"
    );
  });

  it("serializes MariaDB's autoFailover field for replicated workloads", async () => {
    const operator = createOperator(
      "mariadb-operator",
      config({ podDisruptionBudget: { enabled: false } })
    );
    operator.createCluster("maria-replicated", { replicas: 2 });
    await pulumi.runtime.disconnect();

    const spec = inputs("maria-replicated-mariadb")?.spec as Record<string, unknown>;
    expect(spec.replication).toEqual({ enabled: true, primary: { autoFailover: true } });
    expect(spec.replication).not.toHaveProperty("primary.automaticFailover");
  });

  it.each([
    [
      "pod-anti-affinity",
      {
        affinity: {
          podAntiAffinity: {
            preferredDuringSchedulingIgnoredDuringExecution: [
              expect.objectContaining({ weight: 100 }),
            ],
          },
        },
      },
    ],
    [
      "topology-spread",
      {
        topologySpreadConstraints: [
          expect.objectContaining({ whenUnsatisfiable: "ScheduleAnyway" }),
        ],
      },
    ],
  ] as const)(
    "maps MinIO pool %s and creates one isolated pool budget",
    async (strategy, placement) => {
      createOperator(
        "minio",
        config({
          podDisruptionBudget: { enabled: false },
          tenant: { scheduling: { spread: { strategy } } },
        })
      );
      await pulumi.runtime.disconnect();

      const selector = {
        matchLabels: {
          "v1.min.io/tenant": "minio",
          "v1.min.io/console": "minio-console",
          "v1.min.io/pool": "pool-0",
        },
      };
      expect(inputs("minio-tenant")?.spec).toMatchObject({
        pools: [{ name: "pool-0", servers: 1, ...placement }],
      });
      expect(budgets()).toEqual(["minio-tenant-pool-0-pdb"]);
      expect(inputs("minio-tenant-pool-0-pdb", PDB)).toMatchObject({
        metadata: { namespace: "data" },
        spec: { minAvailable: 1, selector },
      });
    }
  );

  it("uses the native Neo4j workload chart budget and scheduling values", async () => {
    createOperator("neo4j", config()).createCluster("graph-test", {
      podDisruptionBudget: { minAvailable: 0 },
      scheduling: { spread: { strategy: "topology-spread", mode: "required" } },
    });
    await pulumi.runtime.disconnect();

    const values = inputs("graph-test-neo4j", HELM_RELEASE)?.values as { value: unknown };
    expect(values.value).toMatchObject({
      podDisruptionBudget: { enabled: true, minAvailable: "0" },
      podSpec: {
        podAntiAffinity: false,
        topologySpreadConstraints: [
          {
            topologyKey: "kubernetes.io/hostname",
            whenUnsatisfiable: "DoNotSchedule",
            labelSelector: {
              matchLabels: { app: "graph-test", "helm.neo4j.com/pod_category": "neo4j-instance" },
            },
          },
        ],
      },
    });
    expect(budgets()).toEqual([]);
  });
});
