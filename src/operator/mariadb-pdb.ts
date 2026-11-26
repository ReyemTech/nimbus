import * as k8s from "@pulumi/kubernetes";
import type { ResolvedPodDisruptionBudget } from "../availability";
import { DATA_NAMESPACE, MARIADB_API_VERSION } from "./mariadb-common.js";
import { toBoundedName } from "./resource-identity.js";

const MARIADB_API_GROUP = MARIADB_API_VERSION.slice(0, MARIADB_API_VERSION.indexOf("/"));
const SYNC_IMAGE =
  "docker.io/library/node:22-alpine@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a";

const SYNC_BUDGET = String.raw`
const { readFileSync } = require("node:fs");
const name = process.env.MARIADB_NAME;
const namespace = encodeURIComponent(process.env.MARIADB_NAMESPACE);
const token = readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").trim();
const api = "https://kubernetes.default.svc/apis/";
const target = "/namespaces/" + namespace;
const pdbPath = "policy/v1" + target + "/poddisruptionbudgets/" + encodeURIComponent(name);
const mariadbVersion = "${MARIADB_API_VERSION}";
const mariadbPath = mariadbVersion + target + "/mariadbs/" + encodeURIComponent(name);

async function request(path, method = "GET", patch) {
  const response = await fetch(api + path, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      ...(patch && { "Content-Type": "application/merge-patch+json" }),
    },
    body: patch && JSON.stringify(patch),
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404 || response.status === 409 || method === "PATCH") {
    await response.body?.cancel();
  }
  if (!response.ok && response.status !== 404 && response.status !== 409) {
    throw new Error(method + " " + path + ": Kubernetes HTTP " + response.status);
  }
  return response;
}

function budgetFields(spec) {
  return {
    minAvailable: spec?.minAvailable ?? null,
    maxUnavailable: spec?.maxUnavailable ?? null,
  };
}

function sameBudget(current, desired) {
  return current.minAvailable === desired.minAvailable &&
    current.maxUnavailable === desired.maxUnavailable;
}

async function reconcile() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const pdbResponse = await request(pdbPath);
    if (pdbResponse.ok) {
      const pdb = await pdbResponse.json();
      const databaseResponse = await request(mariadbPath);
      if (!databaseResponse.ok) throw new Error("MariaDB resource is unavailable: " + name);

      const database = await databaseResponse.json();
      const uid = database.metadata.uid;
      const version = pdb.metadata.resourceVersion;
      const owned = pdb.metadata.ownerReferences?.some((owner) =>
        owner.controller === true && owner.uid === uid && owner.name === name &&
        owner.kind === "MariaDB" && owner.apiVersion === mariadbVersion
      );
      if (!uid || !version || !owned) throw new Error("Unexpected PDB owner or identity: " + name);

      const desired = budgetFields(database.spec.podDisruptionBudget);
      if ((desired.minAvailable === null) === (desired.maxUnavailable === null)) {
        throw new Error("MariaDB must declare exactly one PDB bound: " + name);
      }
      if (sameBudget(budgetFields(pdb.spec), desired)) return;

      // Supplying the old resourceVersion guards against races and replacement.
      // A single merge patch sets the active bound and clears the other bound.
      const patched = await request(pdbPath, "PATCH", {
        metadata: { resourceVersion: version },
        spec: desired,
      });
      if (patched.ok) {
        const latest = await request(mariadbPath);
        if (!latest.ok) throw new Error("MariaDB resource is unavailable: " + name);
        const current = await latest.json();
        if (current.metadata.uid !== uid) throw new Error("MariaDB owner changed: " + name);
        if (sameBudget(budgetFields(current.spec.podDisruptionBudget), desired)) return;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Timed out waiting to reconcile the MariaDB PDB: " + name);
}
reconcile().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
`;

/**
 * Synchronize bounds on the PDB that the MariaDB operator creates and owns.
 * The upstream operator creates a missing PDB and leaves an existing PDB intact.
 */
export function syncMariadbPodDisruptionBudget(
  name: string,
  policy: ResolvedPodDisruptionBudget,
  mariadb: k8s.apiextensions.CustomResource,
  provider: k8s.Provider
): void {
  const jobName = toBoundedName(`${name}-mariadb-pdb-sync`);
  const namespace = DATA_NAMESPACE;
  const metadata = { name: jobName, namespace };
  const apiGroup = "rbac.authorization.k8s.io";

  const account = new k8s.core.v1.ServiceAccount(
    `${jobName}-account`,
    { metadata, automountServiceAccountToken: false },
    { provider, dependsOn: [mariadb] }
  );
  const role = new k8s.rbac.v1.Role(
    `${jobName}-role`,
    {
      metadata,
      rules: [
        {
          apiGroups: ["policy"],
          resources: ["poddisruptionbudgets"],
          resourceNames: [name],
          verbs: ["get", "patch"],
        },
        {
          apiGroups: [MARIADB_API_GROUP],
          resources: ["mariadbs"],
          resourceNames: [name],
          verbs: ["get"],
        },
      ],
    },
    { provider, dependsOn: [mariadb] }
  );
  const binding = new k8s.rbac.v1.RoleBinding(
    `${jobName}-binding`,
    {
      metadata,
      roleRef: { apiGroup, kind: "Role", name: role.metadata.name },
      subjects: [{ kind: "ServiceAccount", name: account.metadata.name, namespace }],
    },
    { provider }
  );

  new k8s.batch.v1.Job(
    jobName,
    {
      metadata: { ...metadata, annotations: { "pulumi.com/replaceUnready": "true" } },
      spec: {
        activeDeadlineSeconds: 300,
        backoffLimit: 0,
        template: {
          // A bound change replaces this completed Job and runs reconciliation again.
          metadata: { annotations: { "nimbus/pdb-policy": JSON.stringify(policy) } },
          spec: {
            restartPolicy: "Never",
            serviceAccountName: account.metadata.name,
            automountServiceAccountToken: true,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 1000,
              runAsGroup: 1000,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: "sync-budget",
                image: SYNC_IMAGE,
                command: ["node", "-e", SYNC_BUDGET],
                env: [
                  { name: "MARIADB_NAME", value: name },
                  { name: "MARIADB_NAMESPACE", value: namespace },
                  {
                    name: "NODE_EXTRA_CA_CERTS",
                    value: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
                  },
                ],
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
              },
            ],
          },
        },
      },
    },
    {
      provider,
      dependsOn: [mariadb, binding],
      deleteBeforeReplace: true,
      replaceOnChanges: ["spec.template"],
    }
  );
}
