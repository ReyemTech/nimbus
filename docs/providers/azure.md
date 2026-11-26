# Azure provider guide

Nimbus supports Azure networking, AKS clusters, node pools, DNS, and Key Vault through Azure Native and Kubernetes providers. Azure cluster creation requires `providerOptions.azure.resourceGroupName`.

## Provider options

For the full factory, use:

```typescript
providerOptions: {
  azure: {
    resourceGroupName: "rg-prod", // Required
    subnetCount: 2,
    azureCni: true,
    virtualNodes: false,
    aadTenantId: "...",
    dnsPrefix: "prod",
    tenantId: "...", // Required for Key Vault
    objectId: "...",
    sku: "standard",
  },
}
```

## AKS capabilities

- Configure Azure CNI, virtual nodes, DNS prefix, and AAD tenant options.
- Use system and user node pools with labels, taints, and spot capacity.
- Attach AKS to Nimbus-created or caller-managed networks.
- Use Azure DNS and Key Vault through the provider-specific factories.

## Azure examples

See [Azure examples](../examples/azure.md).

## More Azure documentation

- [Shared API reference](../api-reference.md)
- [Kubernetes access](../guides/kubernetes-access.md)
