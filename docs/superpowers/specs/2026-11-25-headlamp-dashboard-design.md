# Headlamp Dashboard Design

**Status:** Proposed for approval
**Branch:** `feat/headlamp-dashboard`
**Base:** `origin/main` at `66f4c6f` (Nimbus 3.14.0)

## Goal

Add an opt-in Headlamp dashboard to Nimbus's `createPlatformStack`. Install it as a private in-cluster service, configure integrations for features Nimbus knows are present, and include it in the stack's existing Tailscale exposure output by default. Do not create a public load balancer or an unauthenticated ingress.

## API proposal

Add `headlamp?: IHeadlampConfig` to `IPlatformStackConfig`:

```ts
createPlatformStack("prod", {
  cluster,
  domain: "example.com",
  argocd: { enabled: true },
  headlamp: {
    enabled: true,
    // expose defaults to true; the service remains ClusterIP.
    plugins: {
      additional: [
        {
          name: "my-plugin",
          source: "https://artifacthub.io/packages/headlamp/example/my-plugin",
          version: "1.2.3",
        },
      ],
    },
  },
});

// When Tailscale is configured, include platform.exposedServices in its services.
createAccessGateway("prod-access", {
  cluster,
  provider: "tailscale",
  tailscale: { oauthClientId, oauthClientSecret, routes: [], services: platform.exposedServices },
});
```

Proposed options:

- `enabled?: boolean` — defaults to false.
- `expose?: boolean` — defaults to true when Headlamp is enabled; contributes an `IExposedService` for the existing access gateway. It does not create Tailscale credentials or an access gateway by itself.
- `version?: string` — Headlamp chart version override.
- `namespace?: string` — defaults to `headlamp`.
- `serviceAccountClusterRoleName?: string` — defaults to the built-in read-only `view` role, and may name a caller-reviewed existing ClusterRole.
- `plugins?: { disabled?: HeadlampPluginId[]; additional?: IHeadlampPluginConfig[] }` — Nimbus infers compatible first-party plugin integrations and callers can opt out or install extra pinned Artifact Hub plugins.
- `values?: Record<string, unknown>` — chart values for supported Headlamp settings, with Nimbus retaining safe service/auth defaults.

No change to `createCluster` is proposed: Headlamp is a platform workload, and `createPlatformStack` sees both the returned cluster metadata and its own component selections. This avoids making the cluster factory guess which platform components will be installed later.

## Inferred integrations

| Nimbus capability | Headlamp integration | Selection rule |
| --- | --- | --- |
| cert-manager EKS add-on or platform Helm install | cert-manager plugin | Include when the EKS add-on is present or platform cert-manager is enabled. |
| Karpenter node pool | Karpenter plugin | Include when a cluster node pool uses `scaling.mode: "karpenter"`. |
| Argo CD platform component | Argo CD plugin | Include when `argocd.enabled` is true. The currently Artifact Hub-installable package is a pinned third-party, read-only plugin; label its publisher in docs. |
| Metrics Server | Native Headlamp metrics views | No separate plugin is required. |
| Prometheus | Bundled Headlamp Prometheus plugin | Keep the chart's bundled static plugin enabled; charts appear only when a Prometheus endpoint is available. |
| Traefik, ExternalDNS, Vault, External Secrets, and Nimbus operators | Native Kubernetes/CRD views | No maintained first-party Headlamp plugin was found for these components; generic resources remain visible through Headlamp. |

Automatic plugins use pinned Artifact Hub package versions, including the third-party Argo CD package; `additional` entries also require an explicit version. Do not use `latest` or enable plugin hot-reload by default. Plugins run in Headlamp's UI security context, so docs will tell consumers to use trusted sources and identify plugin publishers.

## Deployment and security

- Deploy Headlamp through the upstream Helm chart, after the cluster provider is ready. Set the Service type to `ClusterIP`; keep chart ingress disabled.
- Use Headlamp's normal per-user authentication flow. Keep `config.unsafeUseServiceAccountToken` false; do not turn the Pod ServiceAccount into the identity shared by every dashboard user.
- Override the upstream chart's default `cluster-admin` binding with a read-only `view` binding for the dashboard Pod ServiceAccount. User-supplied Kubernetes credentials remain governed by their own Kubernetes RBAC. `serviceAccountClusterRoleName` allows a caller to select another existing ClusterRole by name for clusters with reviewed needs.
- Set a stable service name/namespace so the returned `IExposedService` can be passed to `createAccessGateway`. If `expose: false`, omit it from `exposedServices`; the service stays private in-cluster.
- Headlamp has no Nimbus-managed ingress or public Service path. The caller may use `kubectl port-forward` or the existing Tailscale gateway.

## State and lifecycle

The Headlamp Helm release, namespace (if Nimbus creates it), and plugin configuration are Pulumi resources in the same Pulumi stack as `createPlatformStack`. Disabling `headlamp` deletes those resources through normal Pulumi reconciliation. It does not modify cluster/add-on state or the separate Tailscale gateway resources. Removing Headlamp from `exposedServices` on a later update does not implicitly delete an existing access-gateway device unless that access stack is updated too.

## Tests and docs

Focused coverage should verify: disabled-by-default behavior; Headlamp release/provider wiring; ClusterIP and ingress/auth safety defaults; plugin selection for EKS add-ons, Karpenter, and platform Argo CD/cert-manager; deduplication/exclusion/custom pinned plugins; and Tailscale exposure output with the default and opt-out settings. Update API reference, platform docs, and an AWS EKS example showing the dashboard and Tailscale service handoff.

## External references

- Headlamp's in-cluster installation uses a Helm chart and supports plugin-manager configuration: <https://headlamp.dev/docs/latest/installation/in-cluster/>
- Headlamp's security guidance calls for per-user credentials/RBAC, warns against shared ServiceAccount auth, and notes the upstream chart defaults to a `cluster-admin` binding: <https://headlamp.dev/docs/latest/installation/security/>
- The upstream chart defaults to `ClusterIP`, has ingress disabled, bundles static plugins (including Prometheus), and supports pinned plugin-manager config: <https://github.com/kubernetes-sigs/headlamp/blob/main/charts/headlamp/README.md>
- The official plugin catalog lists cert-manager and Karpenter integrations; the Argo CD plugin has an alpha release: <https://github.com/headlamp-k8s/plugins>

## Decisions to confirm

1. Approve the `createPlatformStack` API, private ClusterIP, and default Tailscale exposure output.
2. Approve inferred plugins plus `disabled`/`additional` overrides and the read-only default ServiceAccount binding.
