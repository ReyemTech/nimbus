# Examples

## Pod disruption protection and maintenance

Nimbus defaults supported single-replica controllers and workloads to `minAvailable: 1`; those with multiple replicas use `maxUnavailable: 1`. This affects voluntary evictions such as node drains and autoscaler scale-in. For maintenance, set `podDisruptionBudget: { enabled: false }` on the component, then restore the policy afterward. Keep existing replica counts unless deliberately changing capacity; for multi-replica services configure `scheduling.spread` using pod anti-affinity or topology spread where the component supports it.

```typescript
const access = cluster.createAccessGateway("private-access", {
  type: "tailscale",
  podDisruptionBudget: { enabled: false }, // permit planned node maintenance
});

const cache = createCache("redis", {
  cluster,
  scheduling: {
    replicas: 3,
    spread: { strategy: "topology-spread", mode: "preferred" },
  },
});
```

See [standalone examples](examples/standalone.md#pod-disruption-budget) for policy fields, scope, ownership, and limits.

Examples are split by provider and use case:

- [AWS](examples/aws.md): EKS, add-ons, autoscaling, tagging, and CloudFront private origins.
- [Azure](examples/azure.md): AKS and Azure resources.
- [Multi-cloud](examples/multi-cloud.md): coordinated AWS and Azure stacks.
- [Standalone](examples/standalone.md): resources without cluster creation and state backend.

For portable ServiceAccount kubeconfigs, see the [Kubernetes access guide](guides/kubernetes-access.md).
