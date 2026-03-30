# BCDR Runbook — @reyemtech/nimbus

Business Continuity and Disaster Recovery procedures for multi-cloud deployments managed by nimbus.

## Recovery Objectives

| Metric                             | Target                                       | Notes                                                               |
| ---------------------------------- | -------------------------------------------- | ------------------------------------------------------------------- |
| **RTO** (Recovery Time Objective)  | 15 min (active-active) / 4 hr (single-cloud) | GLB auto-failover vs manual Pulumi redeploy                         |
| **RPO** (Recovery Point Objective) | 0 (stateless) / per-database backup schedule | Application layer is stateless; data layer depends on backup config |

## Scenario 1: Single Cloud Failure (Active-Active)

**Trigger:** AWS or Azure region goes down, GLB health checks fail.

**Automatic response:**

1. Route 53 health checks detect unhealthy cluster (3 consecutive failures, ~90 seconds)
2. DNS routing removes unhealthy cluster from rotation
3. All traffic routes to remaining healthy cluster

**Manual steps (if needed):**

1. Verify failover via `dig app.example.com` — should resolve to healthy cluster only
2. Monitor healthy cluster capacity: `kubectl top nodes`
3. Scale up if needed: adjust `maxNodes` in config, `pulumi up`

**Recovery:**

1. Wait for cloud provider to resolve the issue
2. Health checks automatically restore the recovered cluster to rotation
3. Verify: `dig app.example.com` shows both endpoints

## Scenario 2: Complete Rebuild (Disaster Recovery)

**Trigger:** Need to rebuild entire infrastructure from scratch.

**Steps:**

```bash
# 1. Ensure Pulumi state is accessible
pulumi login  # or pulumi login s3://your-state-bucket

# 2. Set cloud credentials
export AWS_PROFILE=production
az login

# 3. Deploy everything
pulumi up --yes

# 4. Verify
kubectl get nodes --context prod-aws
kubectl get nodes --context prod-azure
curl -I https://app.example.com/health
```

**Time estimate:** ~20 minutes (EKS: ~12 min, AKS: ~8 min, Helm: ~5 min, DNS: ~2 min)

## Scenario 3: Cloud Migration

**Trigger:** Moving from one cloud to another (e.g., AWS → Azure).

**Steps:**

1. Add new cloud to your Pulumi program (see [Migration Guide](migration-guide.md))
2. `pulumi up` — provisions new cloud resources alongside existing
3. Add GLB with `active-passive` strategy (new cloud = secondary)
4. Test: verify the new cluster serves traffic when primary is drained
5. Switch to `active-active` or swap primary/secondary
6. Remove old cloud resources when confident
7. `pulumi up` — destroys old cloud infrastructure

## Scenario 4: Cluster-Level Recovery

**Trigger:** Kubernetes cluster is corrupted but cloud infrastructure is intact.

**Steps:**

```bash
# 1. Destroy just the cluster (preserves network, DNS, secrets)
pulumi destroy --target 'urn:pulumi:prod::app::aws:eks/cluster:Cluster::prod-cluster'

# 2. Re-provision
pulumi up

# 3. Platform stack re-deploys automatically (Helm releases)
# 4. ArgoCD re-syncs application manifests from Git
```

## Scenario 5: Network CIDR Conflict

**Trigger:** Need to peer VPCs that have overlapping CIDRs.

**Steps:**

```typescript
import { buildCidrMap, validateNoOverlaps } from "@reyemtech/nimbus";

// Validate current CIDRs
validateNoOverlaps(["10.0.0.0/16", "10.0.0.0/16"]); // throws CidrError

// Generate non-overlapping CIDRs
const cidrs = buildCidrMap(["aws", "azure", "gcp"]);
// => { aws: "10.0.0.0/16", azure: "10.1.0.0/16", gcp: "10.2.0.0/16" }
```

**Note:** Changing a VPC CIDR requires destroying and recreating the network. Plan CIDRs before initial deployment using `buildCidrMap`.

## Contacts

| Role           | Contact           | Responsibility                                   |
| -------------- | ----------------- | ------------------------------------------------ |
| Infrastructure | Mario Meyer (CTO) | Pulumi deployments, cloud access, cluster issues |
| Application    | Lewis Ning        | Application-layer incidents, ArgoCD              |
| Communications | Sean Williams     | Client notification if outage affects SLA        |

## Pulumi State Management

**State backend:** Pulumi Cloud (or S3/Azure Blob — configurable)

### Provisioning State Storage with nimbus

Use `createStateBackend()` to provision cloud state storage with BCDR features built in:

```typescript
import { createStateBackend } from "@reyemtech/nimbus";
import type { IStateBackend } from "@reyemtech/nimbus";

// AWS: S3 + DynamoDB locking + cross-region replication
const state = (await createStateBackend("prod", {
  cloud: "aws",
  versioning: true,
  encryption: true,
  locking: { enabled: true },
  replication: { enabled: true, destinationRegion: "us-west-2" },
})) as IStateBackend;

// Azure: StorageAccount (HTTPS, TLS 1.2) + GRS geo-replication
const azureState = (await createStateBackend("prod", {
  cloud: "azure",
  versioning: true,
  replication: { enabled: true }, // Uses Standard_GRS SKU
  providerOptions: { azure: { resourceGroupName: "rg-state" } },
})) as IStateBackend;

// Use the backend URL with Pulumi
// state.backendUrl => "s3://prod-state-xxxxx"
// azureState.backendUrl => "azblob://pulumistate"
```

| Feature           | AWS                                             | Azure                      |
| ----------------- | ----------------------------------------------- | -------------------------- |
| **Storage**       | S3 BucketV2                                     | StorageAccount (StorageV2) |
| **Versioning**    | BucketVersioningV2                              | BlobServiceProperties      |
| **Encryption**    | SSE (AES256 or KMS)                             | HTTPS-only, TLS 1.2        |
| **Locking**       | DynamoDB (PAY_PER_REQUEST)                      | Azure blob leases (native) |
| **Replication**   | Cross-region replication (IAM + replica bucket) | Standard_GRS SKU           |
| **Public access** | Always blocked (PublicAccessBlock)              | Always blocked             |

### State Recovery

```bash
# Export state
pulumi stack export > state-backup.json

# Import state (disaster recovery)
pulumi stack import < state-backup.json
```

**Important:** Back up Pulumi state alongside application data. Without state, Pulumi cannot manage existing resources (they become orphans).

## Health Check Verification

```bash
# Check GLB DNS resolution
dig +short app.example.com

# Check individual cluster endpoints
kubectl --context prod-aws get pods -A | head
kubectl --context prod-azure get pods -A | head

# Check platform components
kubectl --context prod-aws get helmrelease -A
kubectl --context prod-azure get helmrelease -A

# Check Route 53 health checks
aws route53 list-health-checks --query 'HealthChecks[].{Id:Id,Status:HealthCheckConfig.FullyQualifiedDomainName}'
```
