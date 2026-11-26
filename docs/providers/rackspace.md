# Rackspace provider guide

Nimbus integrates with Rackspace Spot for managed clusters and can attach to an existing cluster using a supplied kubeconfig or in-cluster ServiceAccount credentials.

## Rackspace cluster modes

Rackspace-managed mode remains the default: Nimbus looks up the Cloudspace,
creates Spot node pools, and retrieves kubeconfig.

```typescript
// Managed Rackspace Spot cluster (the default).
const managed = createCluster("prod", {
  cloud: "rackspace",
  nodePools: [{ name: "workers", instanceType: "gp.vs1.xlarge-iad", minNodes: 2, maxNodes: 3, bidPrice: 0.04 }],
  providerOptions: { rackspace: { cloudspaceName: "reyemtech2" } },
});
```

To connect to a separately managed existing cluster with no Rackspace calls or
resources, use `mode: "existing-cluster"`:

```typescript
const attached = createCluster("prod", {
  cloud: "rackspace",
  nodePools: [],
  providerOptions: {
    rackspace: {
      mode: "existing-cluster",
      kubeconfig: process.env.KUBECONFIG_CONTENT,
      kubeconfigContext: "production",
    },
  },
});
```

After the managed cluster is running, keep `mode` unset (or `"managed"`) and
switch only Kubernetes authentication. Rackspace node pools stay registered in
the stack. Use a Pulumi config value to select the kubeconfig:

```typescript
import * as pulumi from "@pulumi/pulumi";

const useExistingCluster = new pulumi.Config().getBoolean("useExistingCluster") ?? false;
const connected = createCluster("prod", {
  cloud: "rackspace",
  nodePools: [{ name: "workers", instanceType: "gp.vs1.xlarge-iad", minNodes: 2, maxNodes: 3, bidPrice: 0.04 }],
  providerOptions: {
    rackspace: useExistingCluster
      ? { cloudspaceName: "reyemtech2", kubeconfig: new pulumi.Config().require("kubeconfig") }
      : { cloudspaceName: "reyemtech2" },
  },
});
```

For an in-cluster Pulumi run, set `useInClusterConfig: true` instead of
`kubeconfig`. Do not set both.

When a supplied kubeconfig contains multiple contexts, set
`kubeconfigContext` to the desired context name. It defaults to the kubeconfig's
`current-context`, and Nimbus derives `cluster.endpoint` from that same context.

For AWS-only Pulumi targets, use Nimbus's provider-specific AWS entry points and
omit `createCluster()`. This avoids registering Rackspace or Kubernetes
providers while retaining Nimbus's AWS network, secrets, DNS, and state helpers:

```typescript
import { createAwsNetwork, createAwsSecrets } from "@reyemtech/nimbus/aws";

const network = createAwsNetwork("prod", { cloud: "aws", cidr: "10.0.0.0/16" });
const secrets = createAwsSecrets("prod", { cloud: "aws", backend: "aws-secrets-manager" });
```

### Pulumi state ownership when switching modes

For a same-stack credential transition, leave `mode` unset or set it to
`"managed"`, and change only `kubeconfig` or `useInClusterConfig`. Spot node
pools remain registered under the same logical names, so Pulumi continues to
own them. The Kubernetes provider configuration may be updated; review its
preview. Workloads remain tracked in the same stack.

Setting `mode: "existing-cluster"` has different ownership semantics: Nimbus
does not query Rackspace or register Spot resources. If you switch a stack that
currently manages Spot node pools to that mode, Pulumi will plan to delete those
node pools. The Cloudspace lookup is a data source and is not owned in state.

Use `mode: "existing-cluster"` in a separate workload stack, or transfer/import
Spot resources and review the preview before changing ownership modes in one
stack. Switching back to managed mode requires preserving/importing the node-pool
state under its logical names to avoid replacement or duplicate resources.

## Resource and state ownership

Switching modes changes the resources Nimbus manages. Rackspace-managed mode owns Cloudspace and Spot node-pool resources. Existing-cluster mode owns Kubernetes provider configuration and Nimbus-created Kubernetes resources only; it does not import or destroy the external cluster. Pulumi state in each stack remains the source of truth for resources already tracked there. Changing a config value does not automatically transfer resource ownership or safely migrate state. Keep the same Pulumi stack, inspect the preview, and use explicit state import/alias/move procedures if changing a resource's logical owner.

## More Rackspace documentation

- [Shared API reference](../api-reference.md)
- [Kubernetes access](../guides/kubernetes-access.md)
