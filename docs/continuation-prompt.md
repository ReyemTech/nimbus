# Nimbus iad-1 Migration — Continuation Prompt

> Paste this to resume work on the 3 remaining Phase 2 items.

---

Continue the iad-1 migration. Phase 2 is 90% complete — 3 items remain.

**Context:**
- Repos: nimbus at ~/code/ReyemTech/nimbus, iac at ~/code/ReyemTech/iac
- Cluster: iad-1 on reyem.ca, ~80 pods running
- Kubeconfig: ~/.kube/reyemtech-iad.yaml
- AWS profile for Route53/S3: reyem
- Spec: ~/code/ReyemTech/iac/docs/specs/2026-03-28-iad1-migration-design.md
- Pulumi state has broken MinIO entry — already cleaned from Pulumi state, Helm release uninstalled

**What's deployed and working:**
- CNPG cluster `pgsql-main` (PG 17, 2 replicas) with scheduled S3 backups + PITR
- MariaDB `mariadb-main` (11.7) with scheduled S3 backups
- Redis Sentinel (config set to 3 nodes, needs deploy)
- S3 backup target with cross-region replication (us-east-1 → ca-central-1)
- 9 Grafana dashboards in Nimbus folder + 2 per-cluster dashboards (32 Prometheus targets)
- Per-namespace connection secrets in langfuse/, n8n/, kimai/

**3 remaining items:**

## 1. MinIO — Switch from Bitnami to official chart

`src/operator/minio.ts` uses `https://charts.bitnami.com/bitnami` chart `minio` but Bitnami images (docker.io/bitnami/*) can no longer be pulled on Rackspace Spot. Switch to:
- Official MinIO chart: `https://charts.min.io`, chart: `minio`
- Or MinIO Operator chart: `https://operator.min.io`, chart: `operator` + Tenant CRD
- The `createBucket()` Job pattern (mc mb) is fine, just the Helm chart source and values schema need changing
- Storage: use `sata` storageClass, 20Gi default (Rackspace Spot PVC limit is 5-20Gi per ssd/sata volume, sata-large for >=75GB)
- IaC consumer: `iac/src/data.ts` already calls `createOperator("minio")` with langfuse (20Gi) and uploads (50Gi) buckets
- Pulumi state for MinIO is clean (deleted from state after failed deploy)

## 2. Database CRDs — Proper per-database lifecycle

`createDatabase()` currently only creates K8s Secrets in target namespaces with connection info. It does NOT create the actual database, user, or grants on the cluster. It should use operator CRDs:

**CNPG** has CRDs for database lifecycle (check if available in the installed version):
- `Database` CRD — creates a database in the CNPG cluster
- Or use `bootstrap.initdb.postInitApplicationSQL` in the Cluster spec

**MariaDB Operator** has CRDs:
- `Database` CRD (k8s.mariadb.com/v1alpha1) — creates a database
- `User` CRD — creates a user with a generated password
- `Grant` CRD — grants permissions on a database to a user

Currently `createDatabase("langfuse", { namespaces: ["langfuse"] })` should:
1. Create a Database CRD for "langfuse" on the cluster
2. Create a User CRD for "langfuse" with auto-generated password
3. Create a Grant CRD giving the user full access to the database
4. Create K8s Secrets in target namespaces with the user's credentials (not root!)

Files: `src/operator/cnpg.ts` (createSingleCnpgDatabaseInstance), `src/operator/mariadb.ts` (createSingleMariadbDatabaseInstance)

## 3. Storage Tiers — Wire storageClassName through all PVCs

`resolveStorageTier()` exists in `src/types/storage-tiers.ts` but is never called. All PVCs currently use the cluster default storage class (ssd on Rackspace Spot). Per the spec:

| Component | Correct Tier | Rackspace Class |
|-----------|-------------|-----------------|
| Databases (CNPG, MariaDB) | performance | ssd ✓ (default) |
| Cache (Redis) | performance | ssd ✓ (default) |
| Observability (Loki, Prometheus) | standard | sata ✗ (currently ssd) |
| Grafana | standard | sata ✗ (currently ssd) |
| MinIO | standard | sata ✗ |
| Vault | performance | ssd ✓ (default) |

Rackspace Spot storage classes: `sata` (standard), `ssd` (performance), `ssd-large` (high-performance), `sata-large` (>=75GB bulk storage)

The ICluster should carry a `storageTiers` map. For iad-1, the IaC cluster shim in `iac/src/index.ts` needs:
```typescript
const cluster: ICluster = {
  // ... existing fields
  storageTiers: {
    standard: "sata",
    performance: "ssd",
    "high-performance": "ssd-large",
  },
};
```

Then each module reads `cluster.storageTiers` and resolves the tier to a class name. Files to update:
- `src/cluster/interfaces.ts` — add `storageTiers?: StorageTierMap` to `ICluster`
- `src/observability/stack.ts` — pass `storageClass: "sata"` to Loki, Prometheus, Grafana PVCs
- `src/operator/cnpg.ts`, `mariadb.ts` — pass storageClassName from tier
- `src/cache/cache.ts` — pass storageClassName from tier
- `src/operator/minio.ts` — pass storageClassName from tier

**After all 3 items, deploy:** `cd iac && npx tsc && pulumi up -s iad-1 --yes --skip-preview`
Then validate: MinIO accessible, databases created via CRDs, PVC storage classes correct.
