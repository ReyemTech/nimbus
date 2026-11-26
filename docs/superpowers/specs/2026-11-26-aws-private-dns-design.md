# AWS Private DNS and Ingress Visibility Design

## Intent

Add optional Route 53 private hosted-zone support and per-Ingress public/private DNS selection for AWS EKS, while preserving existing ExternalDNS behavior when the feature is omitted. A zone prefix is selectable and defaults to `internal`, allowing cluster-specific names such as `cac-1.reyem.tech`.

## Goals

- Create a private hosted zone and associate it with the EKS cluster VPC, or reference an existing zone by ID.
- Keep public and private Route 53 scopes explicit and separate.
- Route Ingresses using `nimbus.dev/dns-visibility: public|private`; missing annotations remain public.
- Keep Service and Traefik CRD DNS sources on the public controller.
- Avoid deleting records during public-to-private migration unless the caller explicitly selects `sync`.
- Preserve the current single EKS add-on and Helm behavior when split DNS is not configured.

## Non-goals

- Cross-account Route 53 authorization management.
- Automatic inference of load-balancer privacy from arbitrary Ingress controller implementations.
- Changing TLS, Ingress classes, or load-balancer provisioning.
- Tailnet configuration changes; callers can point Tailnet split DNS at the private suffix using the existing access-gateway DNS options.

## API and behavior

Add AWS-only private-zone entries to ExternalDNS configuration. A created entry accepts an optional `prefix` and derives its zone name as `<prefix>.<platform domain>`, defaulting to `internal`. An existing entry requires a hosted-zone ID and explicit domain filter; an optional association flag manages its association to the EKS VPC. The cluster result exposes its AWS VPC ID and region for provider components.

When private zones are configured on EKS, Nimbus replaces the single ExternalDNS add-on path with two Helm-managed controllers. The public controller covers Ingress, Service, and Traefik sources under the existing public TXT owner ID; the private controller selects only explicitly private Ingresses and writes to private zones. Each controller has its own ServiceAccount, Nimbus identity label, and TXT owner ID. The public controller keeps the legacy owner ID without a broad TXT migration flag, so `sync` sees all public source types and cannot claim/delete records outside its desired set. Both controllers use fixed AWS zone types and exact hosted-zone IDs. Split-mode policies default to `upsert-only`; `sync` is explicit.

Legacy flat `hostedZoneIds`, `domainFilters`, values, and single-controller deployment remain unchanged when no private-zone configuration is present.

## Lifecycle and safety

Created zones and explicitly managed associations are Pulumi-owned. Existing zones remain caller-owned. Nimbus will not set `forceDestroy` on zones; a zone containing records must be cleaned up deliberately before deletion. Existing public TXT ownership is retained when configured so the public controller can continue managing records. Private records use a distinct stable owner ID. DNS visibility does not alter TLS or load-balancer settings.

## Approaches considered

1. **Keep EKS community add-on and add a private controller.** Rejected because the add-on's versioned schema does not expose all ExternalDNS filters and zone-selection flags required for a safe split.
2. **Use Nimbus-managed Helm controllers only when private zones are configured.** Selected because Helm exposes the required flags and preserves the add-on path for existing users.
3. **Use one controller with both public and private zones.** Rejected because an unfiltered controller could publish a private target into a public zone.

## Validation

Unit tests cover default compatibility, prefix derivation/default, existing-zone association behavior, exact IAM zone scopes, controller/source filters, ownership IDs, and public/private annotation selection. Docs include a dual-zone EKS example, migration and cleanup instructions, Tailnet suffix alignment, and DNS-01 certificate guidance.
