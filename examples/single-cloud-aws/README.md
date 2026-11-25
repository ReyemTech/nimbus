# Single-Cloud AWS Example

Deploys a full production stack on AWS using the nimbus factory API.

## Components

- **Network** — VPC with public/private subnets and fck-nat (~$3/mo)
- **Cluster** — EKS with Auto Mode, system + spot worker pools
- **DNS** — Route 53 hosted zone with A and CNAME records
- **Secrets** — AWS Secrets Manager for database credentials
- **Platform** — Traefik, cert-manager, External DNS, Argo CD, Vault, and Headlamp

## Architecture

```mermaid
graph LR
  Internet((Internet))

  subgraph AWS["AWS (us-east-1)"]
    R53[Route 53]
    SM[Secrets Manager]

    subgraph VPC["VPC 10.0.0.0/16"]
      NAT[fck-nat]

      subgraph EKS["EKS v1.32"]
        SYS[System Pool]
        WORK[Worker Pool spot]

        subgraph Platform["Platform Stack"]
          TRF[Traefik]
          CM[cert-manager]
          EDNS[External DNS]
          VLT[Vault]
          HLP[Headlamp ClusterIP]
        end
      end
    end
  end

  Internet --> TRF --> WORK
  Tailnet((Tailscale)) --> HLP
  EDNS --> R53
  VLT --> SM
  VPC --> NAT --> Internet
```

## Usage

```bash
pulumi new typescript
npm install @reyemtech/nimbus @pulumi/aws @pulumi/kubernetes
cp index.ts your-project/index.ts
pulumi up
```

Headlamp installs as a private `ClusterIP` service and is included in
`platform.exposedServices`. The example only creates the Tailscale access
gateway when `enableTailscaleAccess` is true. Set the `tailscaleOAuthClientId`
and secret `tailscaleOAuthClientSecret` Pulumi config values to enable it.
Headlamp still uses each user's Kubernetes credentials and RBAC.

For local access without Tailscale:

```bash
kubectl port-forward -n headlamp svc/headlamp 8080:80
```
