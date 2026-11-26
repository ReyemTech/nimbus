/** Default AWS private hosted-zone prefix when one is not specified. */
export const DEFAULT_PRIVATE_DNS_PREFIX = "internal";
/** Public resolvers used for cert-manager DNS-01 checks in split-horizon DNS mode. */
export const DEFAULT_ROUTE53_DNS01_RECURSIVE_NAMESERVERS = ["1.1.1.1:53", "8.8.8.8:53"] as const;

export type ExternalDnsVisibility = "public" | "private";

/** Build a private hosted-zone name below the platform's public domain. */
export function route53PrivateZoneName(
  domain: string,
  prefix = DEFAULT_PRIVATE_DNS_PREFIX
): string {
  const normalizedDomain = domain.trim().replace(/\.$/, "");
  const normalizedPrefix = prefix.trim().replace(/\.$/, "");
  if (!normalizedDomain || normalizedDomain.split(".").some((label) => !isDnsLabel(label))) {
    throw new Error(`Invalid Route 53 domain: ${domain}`);
  }
  if (!isDnsLabel(normalizedPrefix)) {
    throw new Error(`Private DNS prefix must be a single DNS label: ${prefix}`);
  }
  return `${normalizedPrefix}.${normalizedDomain}`;
}

/** ExternalDNS annotation selector; missing visibility intentionally stays public. */
export function externalDnsVisibilityFilter(
  annotation: string,
  visibility: ExternalDnsVisibility
): string {
  return visibility === "private" ? `${annotation}=private` : `${annotation}!=private`;
}

function isDnsLabel(label: string): boolean {
  return label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label);
}
