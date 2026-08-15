/** Unit tests for trusted CloudFront distribution provisioning. */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface IConstructedResource {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

const originRequestPolicies: IConstructedResource[] = [];
const distributions: IConstructedResource[] = [];
const aliases: IConstructedResource[] = [];

vi.mock("@pulumi/aws", () => ({
  cloudfront: {
    OriginRequestPolicy: class {
      readonly id = "origin-request-policy-id";

      constructor(name: string, args: Record<string, unknown>) {
        originRequestPolicies.push({ name, args });
      }
    },
    Distribution: class {
      readonly domainName = "distribution.cloudfront.net";

      constructor(name: string, args: Record<string, unknown>) {
        distributions.push({ name, args });
      }
    },
  },
  route53: {
    Record: class {
      readonly fqdn = "www.reyem.tech";

      constructor(name: string, args: Record<string, unknown>) {
        aliases.push({ name, args });
      }
    },
  },
}));

import { createAwsCloudFront } from "../../src/aws/cloudfront";
import { createCdn } from "../../src/factories/cdn";

beforeEach(() => {
  originRequestPolicies.length = 0;
  distributions.length = 0;
  aliases.length = 0;
});

describe("createAwsCloudFront", () => {
  const config = {
    cloud: "aws" as const,
    hostedZoneId: "Z0123456789EXAMPLE",
    webAclArn: "arn:aws:wafv2:us-east-1:123456789012:global/webacl/shared/example",
    originSecretHeader: "X-Reyem-Origin-Trial",
    originSecretValue: "origin-secret",
    distributions: [
      {
        hostname: "www.reyem.tech",
        originDomainName: "origin.reyem.tech",
        certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/example",
      },
    ],
  };

  it("excludes Host while preserving CloudFront viewer headers", () => {
    createAwsCloudFront("prod", config);

    expect(originRequestPolicies).toEqual([
      {
        name: "prod-origin-request",
        args: {
          cookiesConfig: { cookieBehavior: "all" },
          headersConfig: {
            headerBehavior: "allExcept",
            headers: { items: ["Host"] },
          },
          queryStringsConfig: { queryStringBehavior: "all" },
        },
      },
    ]);
  });

  it("adds the origin secret and static client-host headers", () => {
    createAwsCloudFront("prod", config);

    expect(distributions).toHaveLength(1);
    expect(distributions[0]?.args).toMatchObject({
      aliases: ["www.reyem.tech"],
      webAclId: "arn:aws:wafv2:us-east-1:123456789012:global/webacl/shared/example",
      defaultCacheBehavior: {
        allowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
        cachedMethods: ["GET", "HEAD"],
      },
      origins: [
        {
          domainName: "origin.reyem.tech",
          customHeaders: [
            { name: "X-Reyem-Origin-Trial", value: "origin-secret" },
            { name: "X-Reyem-Client-Host", value: "www.reyem.tech" },
          ],
          customOriginConfig: { originProtocolPolicy: "https-only" },
        },
      ],
    });
  });

  it("creates IPv4 and IPv6 Route 53 aliases for every distribution", () => {
    createAwsCloudFront("prod", config);

    expect(aliases).toEqual([
      {
        name: "prod-www-reyem-tech-a",
        args: {
          zoneId: "Z0123456789EXAMPLE",
          name: "www.reyem.tech",
          type: "A",
          aliases: [
            {
              name: "distribution.cloudfront.net",
              zoneId: "Z2FDTNDATAQYW2",
              evaluateTargetHealth: false,
            },
          ],
        },
      },
      {
        name: "prod-www-reyem-tech-aaaa",
        args: {
          zoneId: "Z0123456789EXAMPLE",
          name: "www.reyem.tech",
          type: "AAAA",
          aliases: [
            {
              name: "distribution.cloudfront.net",
              zoneId: "Z2FDTNDATAQYW2",
              evaluateTargetHealth: false,
            },
          ],
        },
      },
    ]);
  });

  it("rejects headers CloudFront or Traefik cannot safely carry", () => {
    expect(() =>
      createAwsCloudFront("prod", { ...config, clientHostHeader: "X-Forwarded-Host" })
    ).toThrow(/must not use/);
    expect(() =>
      createAwsCloudFront("prod", { ...config, originSecretHeader: "X-Edge-Origin-Secret" })
    ).toThrow(/must not use/);
  });

  it("rejects duplicate aliases before CloudFront rejects the deployment", () => {
    expect(() =>
      createAwsCloudFront("prod", {
        ...config,
        distributions: [
          ...config.distributions,
          {
            hostname: "www.reyem.tech",
            originDomainName: "origin.reyem.tech",
            certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/example",
          },
        ],
      })
    ).toThrow(/configured more than once/);
  });
});

describe("createCdn", () => {
  it("accepts AWS as the only supported CDN provider", () => {
    const cdn = createCdn("prod", {
      cloud: "aws",
      hostedZoneId: "Z0123456789EXAMPLE",
      originSecretHeader: "X-Reyem-Origin-Trial",
      originSecretValue: "origin-secret",
      distributions: [
        {
          hostname: "www.reyem.tech",
          originDomainName: "origin.reyem.tech",
          certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/example",
        },
      ],
    });

    expect(cdn.cloud.provider).toBe("aws");
  });

  it("rejects unsupported and multi-cloud CDN configurations", () => {
    const config = {
      hostedZoneId: "Z0123456789EXAMPLE",
      originSecretHeader: "X-Reyem-Origin-Trial",
      originSecretValue: "origin-secret",
      distributions: [
        {
          hostname: "www.reyem.tech",
          originDomainName: "origin.reyem.tech",
          certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/example",
        },
      ],
    };

    expect(() => createCdn("prod", { ...config, cloud: "azure" })).toThrow(/cdn/);
    expect(() => createCdn("prod", { ...config, cloud: ["aws", "azure"] })).toThrow(/multi-cloud/);
  });
});
