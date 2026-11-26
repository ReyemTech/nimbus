# ServiceAccount kubectl Access and Documentation Refresh

**Status:** Proposed for approval  
**Branch:** `feat/service-account-kubeconfig`

## Goal

Allow Nimbus consumers to create named Kubernetes ServiceAccounts with scoped
RBAC and obtain a complete, portable kubeconfig for each account. Keep
credential lifecycle independent from cluster creation, expose both a
standalone factory and cluster-fluent entry points, and refresh Nimbus's public
documentation so users can find the current API and provider-specific
capabilities without a long README.

## User outcomes

```typescript
const access = cluster.createServiceAccountAccess("ci-reader", {
  scope: { type: "cluster", role: "view" },
});

export const ciKubeconfig = access.kubeconfig;
```

The same operation remains available as a standalone factory:

```typescript
const access = createServiceAccountAccess("ci-reader", {
  cluster,
  scope: { type: "namespace", namespace: "apps", role: "view" },
});
```

Consumers export the returned `kubeconfig` as a Pulumi secret output, then
materialize it as a local file with `pulumi stack output --show-secrets`. Nimbus
does not write credentials to the Pulumi program's working directory.

## Access model

- Create a ServiceAccount, a `kubernetes.io/service-account-token` Secret, and
  the binding required by the selected scope.
- Use a persistent ServiceAccount token so the generated kubeconfig remains
  usable from an external machine until the credential is revoked. The token
  and complete kubeconfig are secret outputs. Deleting the token Secret or
  ServiceAccount revokes the credential; removing the binding removes its
  access.
- Support cluster-wide built-in `cluster-admin` and `view` scopes; namespace
  `admin`, `edit`, and `view` scopes; and a custom Role/ClusterRole reference
  for callers that manage their own RBAC policy.
- Default the ServiceAccount namespace to a dedicated Nimbus access namespace
  and allow an explicit namespace override.
- Build the kubeconfig from the selected cluster endpoint and the CA/token
  values populated on the token Secret. Permit an explicit API server override
  for clusters whose `ICluster.endpoint` is unavailable, such as an
  in-cluster-only attachment. Return a clear error when required connection
  data is absent.
- Preserve current free-function APIs. Add fluent methods for high-level
  cluster operations: ServiceAccount access, access gateway, platform stack,
  observability stack, operator deployment, and Argo CD setup. Keep low-level
  resource helpers and already-fluent Operator/Argo CD objects unchanged.
- Preserve structural compatibility for consumers that construct their own
  `ICluster`: return a new fluent cluster subtype from Nimbus cluster factories
  rather than making the new methods required on `ICluster`.

## Documentation refresh

- Rework `README.md` into a concise package overview, installation and quick
  start, then a clear documentation navigation section.
- Add `docs/README.md` as the documentation index.
- Add provider guides for AWS, Azure, and Rackspace. Move detailed provider
  features out of the README and into the matching guide.
- Split the long examples guide into focused AWS, Azure, multi-cloud, and
  standalone examples; keep `docs/examples.md` as a short index with stable
  links.
- Keep the API reference focused on shared public contracts and link to
  provider guides for detailed AWS/Azure/Rackspace behavior.
- Audit and reconcile docs against current code for the recent Nimbus work:
  EKS options and add-ons, autoscaling ownership, resource tags, CloudFront
  private ALB/NLB origins, Rackspace managed/existing modes and state ownership,
  Headlamp and Tailscale exposure, SBOM/package behavior, and this
  ServiceAccount capability.
- Repair stale navigation, examples, API names, and claims found during the
  audit; preserve standalone and provider-specific examples users rely on.

## API boundaries and non-goals

- This is Kubernetes access. It does not replace cloud IAM or make the Nimbus
  Pulumi deployment identity part of the generated kubeconfig.
- `cluster-admin` is explicit; no access account receives it by default.
- Fluent methods are convenience wrappers around the existing standalone
  factories and keep their existing resource semantics.
- This work does not add fluent wrappers for every low-level helper or
  restructure non-cluster APIs.
- No access token is printed in logs or written to a local file automatically.

## Risks to resolve in implementation

- Kubernetes asynchronously populates legacy token Secrets. The implementation
  must ensure the kubeconfig output is not considered ready until token and CA
  data are available, and must fail clearly if the target cluster does not
  populate the token Secret.
- The token and generated kubeconfig must remain marked secret through all
  Pulumi outputs and examples.
- New fluent methods must not force existing external `ICluster` implementations
  to add required properties or break callers using existing free functions.
- Moving documentation must preserve working links and every supported
  provider feature and example.

## External references

- Kubernetes documents token Secrets as a legacy mechanism for long-lived
  credentials and recommends the short-lived TokenRequest API for most use
  cases: <https://kubernetes.io/docs/concepts/configuration/secret/#serviceaccount-token-secrets>.
- Kubernetes documents how the controller populates a manually created token
  Secret and how the resulting token is revoked with the ServiceAccount:
  <https://kubernetes.io/docs/tasks/configure-pod-container/configure-service-account/#manually-create-a-long-lived-api-token-for-a-serviceaccount>.

## Validation expectations

- Verify each supported RBAC scope creates the expected binding and ServiceAccount
  subject.
- Verify the generated kubeconfig selects the expected endpoint, CA, token,
  context, and namespace and remains secret-valued.
- Verify both factory and fluent calls share the same behavior and resource
  lifecycle.
- Check all cluster factories expose the fluent subtype without changing the
  existing `ICluster` input contract.
- Run documentation link checks and confirm every prior README/API/example
  topic has a destination in the refreshed docs.
- Run the full test, typecheck, lint, format, and build checks before PR review.
