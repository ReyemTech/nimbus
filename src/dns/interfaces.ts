/**
 * DNS interfaces for @reyemtech/nimbus.
 *
 * Abstracts DNS zone management across Route 53 (AWS),
 * Azure DNS Zone, and Cloud DNS (GCP).
 *
 * @module dns/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type { CloudArg, ResolvedCloudTarget } from "../types";

/** Supported DNS record types. */
export type DnsRecordType = "A" | "AAAA" | "CNAME" | "TXT" | "MX" | "NS" | "SRV" | "CAA";

/** Typed constant map for DnsRecordType string literals. */
export const DNS_RECORD_TYPES = {
  A: "A" as const,
  AAAA: "AAAA" as const,
  CNAME: "CNAME" as const,
  TXT: "TXT" as const,
  MX: "MX" as const,
  NS: "NS" as const,
  SRV: "SRV" as const,
  CAA: "CAA" as const,
} satisfies Record<string, DnsRecordType>;

/** DNS record configuration. */
export interface IDnsRecord {
  /** Record name relative to zone (e.g., "www" or "argocd"). Use "@" for apex. */
  readonly name: string;
  /** DNS record type (e.g., "A", "CNAME", "TXT"). */
  readonly type: DnsRecordType;
  /** Record values (e.g., IP addresses, hostnames, or TXT content). */
  readonly values: ReadonlyArray<string>;
  /** TTL in seconds. Default: 300. */
  readonly ttl?: number;
}

/**
 * DNS configuration input.
 *
 * @example
 * ```typescript
 * const config: IDnsConfig = {
 *   cloud: "aws",
 *   zoneName: "reyem.tech",
 * };
 * ```
 */
export interface IDnsConfig {
  /** Cloud provider target or multi-cloud array. */
  readonly cloud: CloudArg;
  /** Fully qualified domain name for the DNS zone (e.g., "reyem.tech"). */
  readonly zoneName: string;
  /** Initial DNS records to create in the zone. */
  readonly records?: ReadonlyArray<IDnsRecord>;
  /** Resource tags applied to the DNS zone. */
  readonly tags?: Readonly<Record<string, string>>;
}

/**
 * DNS output — the created DNS zone.
 *
 * Use `addRecord()` to manage records in the zone.
 */
export interface IDns {
  /** Logical name of the DNS zone resource. */
  readonly name: string;
  /** Resolved cloud target this DNS zone was provisioned on. */
  readonly cloud: ResolvedCloudTarget;
  /** Cloud-assigned zone ID (Route 53 zone ID, Azure zone name, etc.). */
  readonly zoneId: pulumi.Output<string>;
  /** Fully qualified domain name of the zone. */
  readonly zoneName: string;
  /** Authoritative name servers for this zone. */
  readonly nameServers: pulumi.Output<ReadonlyArray<string>>;

  /** Add a DNS record to the zone. */
  addRecord(record: IDnsRecord): void;

  /** Escape hatch: cloud-native DNS zone resource. */
  readonly nativeResource: pulumi.Resource;
}
