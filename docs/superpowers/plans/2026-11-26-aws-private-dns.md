# AWS Private DNS and Ingress Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add optional AWS EKS private Route 53 zones and per-Ingress DNS visibility with a selectable zone prefix defaulting to `internal`.

**Architecture:** Keep legacy ExternalDNS untouched when private zones are absent. When configured for EKS, create or associate private zones and deploy distinct Helm ExternalDNS controllers with source-specific filters and zone-scoped Pod Identity roles.

**Tech Stack:** TypeScript, Pulumi AWS, Pulumi Kubernetes Helm, Vitest, Markdown.

**Spec:** `docs/superpowers/specs/2026-11-26-aws-private-dns-design.md`

## Global Constraints

- Feature is AWS EKS and Route 53 specific and opt-in.
- Missing Ingress visibility annotation continues to mean public.
- Created private-zone prefix defaults to `internal`.
- Split-mode record policy defaults to `upsert-only`; deleting policy is explicit.
- Existing zones are never deleted; no hosted zone uses force-destroy.
- Existing public configuration and TXT owner IDs remain compatible.

## Review Focus

- EKS add-on to Helm transition: test distinct namespaces/releases and retained public ownership.
- Private-zone creation defaults: test `internal.<domain>` and explicit prefix.
- Existing-zone lifecycle: test default unmanaged association and explicit Nimbus-managed association.
- Filter semantics: test missing/public/private annotation selection and zone-type restrictions.
- IAM scope: test each controller's record-change permissions include only its zones.

---

### Task 1: Public API and cluster AWS networking outputs

**Files:**
- Modify: `src/platform/interfaces.ts`
- Modify: `src/cluster/interfaces.ts`
- Modify: `src/aws/cluster.ts`
- Modify: `src/index.ts`
- Test: `tests/unit/aws-cluster.test.ts`

Add public/private Route 53 visibility types and optional `ICluster.awsVpcId` / `awsRegion`. Add failing tests showing the EKS result returns the network VPC ID and cluster region and that the private prefix API is typed/exported.

### Task 2: Private hosted zones and split EKS ExternalDNS

**Files:**
- Modify: `src/platform/components/external-dns-eks.ts`
- Modify: `src/platform/components/external-dns.ts`
- Modify: `src/platform/stack.ts`
- Modify: `src/platform/interfaces.ts`
- Test: `tests/unit/external-dns-eks.test.ts`
- Test: `tests/unit/platform-stack.test.ts`

Add create/existing private zones, optional existing-zone VPC association, explicit private domain filters, exact per-controller IAM scopes, separate Pod Identity ServiceAccounts, Helm deployment values, and preservation of the legacy add-on path. Tests assert zone name/association, controller resources, source filters, public/private policies, unique TXT IDs, and no cross-zone write permissions.

### Task 3: Documentation and examples

**Files:**
- Modify: `docs/examples/aws.md`
- Modify: `docs/providers/aws.md`
- Modify: `docs/api-reference.md`
- Modify: `README.md`

Document public and private Ingress annotations, a `cac-1` prefix example, `internal` default, one-apply migration behavior, staged record cleanup, existing-zone ownership, Tailnet split-DNS suffix alignment, and DNS-01 certificate behavior.

### Task 4: Verification

Run focused unit tests for the changed platform/cluster paths, then the complete unit test suite, TypeScript typecheck, build, and lint. Fix any failures before reporting completion.
