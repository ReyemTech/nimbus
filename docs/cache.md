# Cache deployments

`createCache` provisions an in-cluster Redis or Valkey cache through Helm. Omitting `engine` keeps the existing Redis behavior. Valkey is opt-in and uses the [official Valkey Helm chart](https://github.com/valkey-io/valkey-helm), pinned by default to chart version `1.0.0`.

## Valkey

```typescript
import { createCache } from "@reyemtech/nimbus";

const sessions = createCache(
  "sessions",
  {
    cloud: "aws",
    engine: "valkey",
    mode: "helm",
    architecture: "replication",
    replicas: 2, // read replicas in addition to the primary
    storageGb: 8,
    storageTier: "performance",
    metrics: true,
    namespaces: ["apps"],
  },
  kubernetesProvider
);

export const valkeyEndpoint = sessions.endpoint;
export const valkeyPort = sessions.port;
```

Nimbus generates Valkey ACL and Sentinel credentials, stores them in the `data` namespace, and provides a `secretRef`. For each namespace in `namespaces`, it creates a connection Secret named `<cache-name>-valkey` with `host`, `port`, `username`, `password`, and `uri` keys. The endpoint is the chart's HAProxy write service, so application clients do not need Sentinel support. `chartVersion` can pin a different version of the official chart; Nimbus defaults to `1.0.0`.

Valkey `architecture: "replication"` enables the chart's Sentinel failover and HAProxy write routing. With defaults, that is **three Valkey pods** (one primary and two replicas), **three Sentinel pods**, and **three HAProxy pods**. Each Valkey pod has a persistent volume. This is a nine-pod deployment before metrics sidecars. Use standalone for a smaller footprint:

```typescript
const localCache = createCache(
  "local",
  {
    cloud: "aws",
    engine: "valkey",
    architecture: "standalone",
    storageGb: 5,
  },
  kubernetesProvider
);
```

Standalone creates one Valkey pod with persistence and no Sentinel or HAProxy. Cluster/sharded architecture and managed-service mode are not supported by Nimbus's Valkey adapter. To use a hosted Valkey-compatible service, configure that service separately and pass its connection information to the consuming application.

### Availability and placement

Nimbus enables chart-managed PodDisruptionBudgets for the Valkey, Sentinel, and HAProxy workloads. Each allows at most one unavailable pod by default; Sentinel's budget must also preserve quorum. Standalone mode uses a Nimbus-managed PDB that keeps its single pod available, which can block node drains or autoscaler scale-in. Set `podDisruptionBudget: { enabled: false }` to permit planned evictions.

`scheduling.replicas` controls the number of Valkey read replicas (in addition to the primary) in replication mode. `scheduling.spread` applies placement rules to Valkey, Sentinel, and HAProxy pods so the groups can spread across nodes or topology zones.

### Switching from Redis

Changing `engine` from `redis` to `valkey` changes the Helm release and its managed resources. Nimbus does not copy Redis data into Valkey. Plan and run an application-aware data migration or cache warm-up before switching consumers to the new endpoint. Keep both caches during cutover if the data is not disposable; remove the old Redis release only after consumers have moved and the old cache is no longer needed.

## Redis compatibility

Existing callers can omit `engine` or continue setting `engine: "redis"`; both retain Nimbus's Bitnami Redis path. The Valkey adapter does not change Redis release names or Redis endpoints.
