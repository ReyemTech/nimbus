# Kubernetes access with ServiceAccounts

Nimbus can create a dedicated ServiceAccount, a persistent token Secret, a scoped RBAC binding, and a portable kubeconfig. Use this for external automation or operators that need Kubernetes API access without sharing a human kubeconfig.

## Cluster-fluent API

```typescript
import { createCluster } from "@reyemtech/nimbus";

const cluster = createCluster("prod", {
  cloud: "aws",
  nodePools: [{ name: "system", instanceType: "t4g.large", minNodes: 2, maxNodes: 4 }],
}, network);

const ci = cluster.createServiceAccountAccess("ci-reader", {
  scope: { type: "namespace", namespace: "apps", role: "view" },
});

export const ciKubeconfig = ci.kubeconfig;
```

## Standalone factory

The standalone entry point works with any caller-provided `ICluster`, including existing-cluster attachments:

```typescript
import { createServiceAccountAccess } from "@reyemtech/nimbus";

const deployer = createServiceAccountAccess("release-bot", {
  cluster,
  scope: { type: "cluster", role: "cluster-admin" },
});

export const deployerKubeconfig = deployer.kubeconfig;
```

`cluster-admin` is intentionally explicit. Prefer the narrowest scope that supports the workload.

## Supported scopes

| Scope | Binding | Built-in roles |
| --- | --- | --- |
| `{ type: "cluster", role }` | ClusterRoleBinding | `cluster-admin`, `view` |
| `{ type: "namespace", namespace, role }` | RoleBinding to built-in ClusterRole | `admin`, `edit`, `view` |
| `{ type: "custom", roleRef }` | ClusterRoleBinding for ClusterRole | Caller-managed ClusterRole |
| `{ type: "custom", namespace, roleRef }` | RoleBinding in namespace | Caller-managed Role or ClusterRole |

A custom `Role` always requires a binding namespace. Nimbus references caller-managed custom roles but does not create or change them. The ServiceAccount is created in `nimbus-access` by default; override `namespace` when needed. For namespace scopes, the binding namespace is the permission target while the ServiceAccount remains in its configured namespace.

The permission target namespace must already exist on the cluster. Nimbus manages the generated ServiceAccount namespace and binding, while leaving target namespaces and custom Role/ClusterRole definitions under the caller's ownership.

Nimbus disables automatic token mounting on the generated ServiceAccount. The persistent token Secret is still created for the exported kubeconfig, but Pods using this ServiceAccount will not receive that token through the default projected volume.

## Save and use the kubeconfig

Export the kubeconfig from the Pulumi program, then materialize it through the Pulumi CLI:

```bash
pulumi stack output ciKubeconfig --show-secrets > ci-kubeconfig.yaml
KUBECONFIG=ci-kubeconfig.yaml kubectl get pods -n apps
```

Protect the generated file like a password. Do not commit it, attach it to tickets, or publish it in CI logs/artifacts. Nimbus returns the kubeconfig as a Pulumi secret output and does not write credentials into the program's working directory.

## Token lifecycle and revocation

The token uses a Kubernetes `kubernetes.io/service-account-token` Secret so it remains portable and usable from another machine. This is a long-lived credential. Kubernetes recommends short-lived TokenRequest tokens for most workloads; this persistent option exists for portable kubeconfig workflows.

Revoke access by deleting the token Secret or ServiceAccount. Removing its RoleBinding/ClusterRoleBinding removes its permissions. Rotate by replacing the token Secret and regenerating/exporting the kubeconfig. Ensure the Pulumi backend encrypts secrets and restrict access to stack outputs.

With `@pulumi/kubernetes` 4.18 or later, Nimbus waits for the Secret's `data.token` to be populated before considering it ready. If the target cluster does not run the ServiceAccount token controller, Pulumi will fail with a readiness timeout; use an alternative identity mechanism for such clusters.

## Cluster fluent factories

Nimbus-created clusters expose fluent wrappers for high-level cluster factories: `createServiceAccountAccess`, `createAccessGateway`, `createPlatformStack`, `createObservabilityStack`, `createOperator`, and `createArgoCD`. They supply the owning cluster to the same standalone factory APIs. Low-level resource helpers remain independently composable, and the existing `ICluster` interface remains structurally compatible for caller-created objects.

See [AWS](../providers/aws.md), [Azure](../providers/azure.md), [Rackspace](../providers/rackspace.md), and the [API reference](../api-reference.md) for provider-specific cluster setup.
