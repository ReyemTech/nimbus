/**
 * AWS CloudFront implementation for the trusted application edge.
 *
 * @module aws/cloudfront
 */

import * as aws from "@pulumi/aws";
import type * as pulumi from "@pulumi/pulumi";
import type { ICdn, ICdnConfig } from "../cdn";
import { ConfigError, resolveCloudTarget } from "../types";

const DEFAULT_CLIENT_HOST_HEADER = "X-Reyem-Client-Host";
const FORWARDED_HEADER_PREFIX = "x-forwarded-";
const RESERVED_HEADER_PREFIX = "x-edge-";
const MANAGED_CACHING_OPTIMIZED_POLICY_ID = "658327ea-f89d-4fab-a63d-7e88639e58f6";
const DEFAULT_ALLOWED_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"];
const DEFAULT_CACHED_METHODS = ["GET", "HEAD"];

/**
 * Create one CloudFront distribution per public hostname for a trusted edge.
 *
 * The origin request policy deliberately excludes `Host`: Traefik rewrites that header, while
 * CloudFront's viewer headers remain available to the application. The two custom headers are
 * static per distribution, which is why a distribution cannot serve multiple hostnames.
 *
 * @throws {ConfigError} When configuration contains unsafe header names or duplicate hostnames.
 */
export function createAwsCloudFront(name: string, config: ICdnConfig): ICdn {
  const cloud = Array.isArray(config.cloud) ? (config.cloud[0] ?? "aws") : config.cloud;
  const target = resolveCloudTarget(cloud);
  const clientHostHeader = config.clientHostHeader ?? DEFAULT_CLIENT_HOST_HEADER;

  validateConfig(config, clientHostHeader);

  const originRequestPolicy = new aws.cloudfront.OriginRequestPolicy(`${name}-origin-request`, {
    cookiesConfig: { cookieBehavior: "all" },
    headersConfig: {
      headerBehavior: "allExcept",
      headers: { items: ["Host"] },
    },
    queryStringsConfig: { queryStringBehavior: "all" },
  });

  const distributions = Object.fromEntries(
    config.distributions.map((distribution) => {
      const resourceName = `${name}-${toResourceName(distribution.hostname)}`;
      const originId = `${resourceName}-origin`;
      const resource = new aws.cloudfront.Distribution(resourceName, {
        aliases: [distribution.hostname],
        enabled: true,
        isIpv6Enabled: true,
        origins: [
          {
            domainName: distribution.originDomainName,
            originId,
            customHeaders: [
              { name: config.originSecretHeader, value: config.originSecretValue },
              { name: clientHostHeader, value: distribution.hostname },
            ],
            customOriginConfig: {
              httpPort: 80,
              httpsPort: 443,
              originProtocolPolicy: "https-only",
              originSslProtocols: ["TLSv1.2"],
            },
          },
        ],
        defaultCacheBehavior: {
          allowedMethods: DEFAULT_ALLOWED_METHODS,
          cachedMethods: DEFAULT_CACHED_METHODS,
          cachePolicyId: MANAGED_CACHING_OPTIMIZED_POLICY_ID,
          originRequestPolicyId: originRequestPolicy.id,
          targetOriginId: originId,
          viewerProtocolPolicy: "redirect-to-https",
        },
        priceClass: "PriceClass_100",
        restrictions: { geoRestriction: { restrictionType: "none" } },
        viewerCertificate: {
          acmCertificateArn: distribution.certificateArn,
          minimumProtocolVersion: "TLSv1.2_2021",
          sslSupportMethod: "sni-only",
        },
        tags: { ...(config.tags ?? {}), Name: resourceName },
      });

      return [distribution.hostname, resource.domainName];
    })
  );

  const aliases = Object.fromEntries(
    config.distributions.map((distribution) => {
      const resourceName = `${name}-${toResourceName(distribution.hostname)}`;
      const cloudFrontDistribution = distributions[distribution.hostname];
      if (!cloudFrontDistribution) {
        throw new ConfigError(
          `CloudFront distribution for "${distribution.hostname}" was not created`,
          "CONFIG_INVALID",
          "distributions"
        );
      }

      const a = createAliasRecord(
        `${resourceName}-a`,
        distribution.hostname,
        "A",
        config.hostedZoneId,
        cloudFrontDistribution
      );
      const aaaa = createAliasRecord(
        `${resourceName}-aaaa`,
        distribution.hostname,
        "AAAA",
        config.hostedZoneId,
        cloudFrontDistribution
      );

      return [distribution.hostname, { a: a.fqdn, aaaa: aaaa.fqdn }];
    })
  );

  return {
    name,
    cloud: target,
    distributions,
    aliases,
    nativeResource: originRequestPolicy,
  };
}

function createAliasRecord(
  resourceName: string,
  hostname: string,
  type: "A" | "AAAA",
  zoneId: pulumi.Input<string>,
  distributionDomainName: pulumi.Input<string>
): aws.route53.Record {
  return new aws.route53.Record(resourceName, {
    zoneId,
    name: hostname,
    type,
    aliases: [
      {
        name: distributionDomainName,
        zoneId: "Z2FDTNDATAQYW2",
        evaluateTargetHealth: false,
      },
    ],
  });
}

function validateConfig(config: ICdnConfig, clientHostHeader: string): void {
  if (config.distributions.length === 0) {
    throw new ConfigError("At least one CloudFront distribution is required", "CONFIG_MISSING");
  }

  validateCustomHeader(config.originSecretHeader, "originSecretHeader");
  validateCustomHeader(clientHostHeader, "clientHostHeader");

  const hostnames = new Set<string>();
  for (const distribution of config.distributions) {
    const hostname = distribution.hostname.toLowerCase();
    if (hostname !== distribution.hostname || hostname.includes(":")) {
      throw new ConfigError(
        `Distribution hostname "${distribution.hostname}" must be a lowercase hostname without a port`,
        "CONFIG_INVALID",
        "distributions"
      );
    }
    if (hostnames.has(hostname)) {
      throw new ConfigError(
        `CloudFront alias "${distribution.hostname}" is configured more than once`,
        "CONFIG_INVALID",
        "distributions"
      );
    }
    hostnames.add(hostname);
  }
}

function validateCustomHeader(header: string, configKey: string): void {
  const normalized = header.toLowerCase();
  if (
    normalized.startsWith(FORWARDED_HEADER_PREFIX) ||
    normalized.startsWith(RESERVED_HEADER_PREFIX)
  ) {
    throw new ConfigError(
      `${configKey} must not use the ${FORWARDED_HEADER_PREFIX} or ${RESERVED_HEADER_PREFIX} prefix`,
      "CONFIG_INVALID",
      configKey
    );
  }
}

function toResourceName(hostname: string): string {
  return hostname.replaceAll(".", "-");
}
