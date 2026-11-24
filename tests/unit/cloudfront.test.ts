/** Unit tests for trusted CloudFront distribution provisioning. */
/* eslint-disable @typescript-eslint/no-extraneous-class -- Pulumi resource constructors are test doubles. */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface IConstructedResource {
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly opts?: unknown;
}

const originRequestPolicies: IConstructedResource[] = [];
const distributions: IConstructedResource[] = [];
const aliases: IConstructedResource[] = [];
const vpcOrigins: IConstructedResource[] = [];
const securityGroupRules: IConstructedResource[] = [];

const mockPulumi = vi.hoisted(() => {
  const unwrap = (value: unknown): unknown =>
    typeof value === "object" && value !== null && "__mockOutput" in value
      ? (value as unknown as { value: unknown }).value
      : value;
  const output = (value: unknown) => ({
    __mockOutput: true,
    value,
    apply: (fn: (value: unknown) => unknown) => output(unwrap(fn(unwrap(value)))),
  });
  return {
    output,
    all: (values: ReadonlyArray<unknown>) => output(values.map(unwrap)),
  };
});

const mockAwsState = vi.hoisted(() => ({
  alb: {
    arn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/private/abc",
    dnsName: "internal-traefik-123.us-east-1.elb.amazonaws.com",
    loadBalancerType: "application",
    internal: true,
    region: "us-east-1",
    subnets: ["subnet-a", "subnet-b"],
    securityGroups: ["sg-alb-a", "sg-alb-b"],
    vpcId: "vpc-123",
  },
  subnet: {
    availabilityZoneId: "use1-az1",
    availableIpAddressCount: 20,
    mapPublicIpOnLaunch: false,
    vpcId: "vpc-123",
  },
  routeTable: {
    routes: [{ cidrBlock: "10.0.0.0/16", ipv6CidrBlock: "", gatewayId: "local" }],
  },
  internetGateway: { attachments: [{ vpcId: "vpc-123", state: "available" }] },
  managedSecurityGroups: { ids: ["sg-cloudfront-vpc-origin"] },
}));

vi.mock("@pulumi/pulumi", () => mockPulumi);

vi.mock("@pulumi/aws", () => ({
  lb: {
    getLoadBalancerOutput: vi.fn(() => mockPulumi.output(mockAwsState.alb)),
  },
  ec2: {
    getSubnetOutput: vi.fn(({ id }: { id: string }) =>
      mockPulumi.output({ ...mockAwsState.subnet, id })
    ),
    getRouteTableOutput: vi.fn(() => mockPulumi.output(mockAwsState.routeTable)),
    getInternetGatewayOutput: vi.fn(() => mockPulumi.output(mockAwsState.internetGateway)),
    getSecurityGroupsOutput: vi.fn(() => mockPulumi.output(mockAwsState.managedSecurityGroups)),
    SecurityGroupRule: class {
      constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
        securityGroupRules.push({ name, args, opts });
      }
    },
  },
  cloudfront: {
    OriginRequestPolicy: class {
      readonly id = "origin-request-policy-id";

      constructor(name: string, args: Record<string, unknown>) {
        originRequestPolicies.push({ name, args });
      }
    },
    Distribution: class {
      readonly domainName = "distribution.cloudfront.net";

      constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
        distributions.push({ name, args, opts });
      }
    },
    VpcOrigin: class {
      readonly id = mockPulumi.output("vo-123");

      constructor(name: string, args: Record<string, unknown>, opts?: unknown) {
        vpcOrigins.push({ name, args, opts });
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
import type { ICdnConfig } from "../../src/cdn";

beforeEach(() => {
  originRequestPolicies.length = 0;
  distributions.length = 0;
  aliases.length = 0;
  vpcOrigins.length = 0;
  securityGroupRules.length = 0;
  mockAwsState.alb.loadBalancerType = "application";
  mockAwsState.alb.internal = true;
  mockAwsState.alb.region = "us-east-1";
  mockAwsState.alb.subnets = ["subnet-a", "subnet-b"];
  mockAwsState.alb.securityGroups = ["sg-alb-a", "sg-alb-b"];
  mockAwsState.subnet.availabilityZoneId = "use1-az1";
  mockAwsState.subnet.availableIpAddressCount = 20;
  mockAwsState.subnet.mapPublicIpOnLaunch = false;
  mockAwsState.routeTable.routes = [
    { cidrBlock: "10.0.0.0/16", ipv6CidrBlock: "", gatewayId: "local" },
  ];
  mockAwsState.internetGateway.attachments = [{ vpcId: "vpc-123", state: "available" }];
  mockAwsState.managedSecurityGroups.ids = ["sg-cloudfront-vpc-origin"];
});

describe("createAwsCloudFront", () => {
  const publicDistribution = {
    hostname: "www.reyem.tech",
    originDomainName: "origin.reyem.tech",
    certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/example",
    orderedCacheBehaviors: [
      {
        pathPattern: "/booking-confirmed*",
        cachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5e77f2f582",
        originRequestPolicyId: "0887d865-4f00-4e99-a2c8-5c2e2b8ee5a7",
      },
    ],
  };
  const config = {
    cloud: "aws" as const,
    hostedZoneId: "Z0123456789EXAMPLE",
    webAclArn: "arn:aws:wafv2:us-east-1:123456789012:global/webacl/shared/example",
    originSecretHeader: "X-Reyem-Origin-Trial",
    originSecretValue: "origin-secret",
    distributions: [publicDistribution],
  };

  it("requires either a public domain origin or shared VPC origin", () => {
    const privateOriginConfig = {
      cloud: "aws" as const,
      hostedZoneId: "Z0123456789EXAMPLE",
      originSecretHeader: "X-Reyem-Origin-Trial",
      originSecretValue: "origin-secret",
      vpcOrigin: {
        type: "alb-vpc",
        albArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/private/abc",
      },
      distributions: [
        {
          hostname: "app1.example.com",
          aliases: ["app2.example.com"],
          certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/example",
        },
      ],
    } satisfies ICdnConfig;

    expect(() =>
      createAwsCloudFront("prod", {
        ...config,
        distributions: [
          {
            hostname: "www.reyem.tech",
            certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/example",
          },
        ],
      })
    ).toThrow(/originDomainName|vpcOrigin/);

    expect(privateOriginConfig.vpcOrigin.type).toBe("alb-vpc");
  });

  it("creates one private ALB VPC Origin and ingress from its managed security group", () => {
    const privateOriginConfig = {
      ...config,
      vpcOrigin: {
        type: "alb-vpc" as const,
        albArn: "arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/private/abc",
        originProtocolPolicy: "http-only" as const,
        albSecurityGroupIds: ["sg-alb-a", "sg-alb-b"],
      },
      distributions: [
        {
          hostname: "app1.example.com",
          aliases: ["app2.example.com"],
          certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/example",
        },
      ],
    };

    createAwsCloudFront("prod", privateOriginConfig);

    expect(vpcOrigins).toHaveLength(1);
    expect(vpcOrigins[0]?.args.vpcOriginEndpointConfig).toMatchObject({
      arn: expect.objectContaining({ value: mockAwsState.alb.arn }),
      httpPort: 80,
      httpsPort: 443,
      originProtocolPolicy: "http-only",
      originSslProtocols: { items: ["TLSv1.2"], quantity: 1 },
    });
    expect(securityGroupRules).toHaveLength(2);
    expect(securityGroupRules[0]?.args).toMatchObject({
      type: "ingress",
      protocol: "tcp",
      fromPort: 80,
      toPort: 80,
      securityGroupId: "sg-alb-a",
      sourceSecurityGroupId: expect.objectContaining({ value: "sg-cloudfront-vpc-origin" }),
    });
  });

  it("uses the shared private origin for aliases and disables caching by default", () => {
    const cdn = createAwsCloudFront("prod", {
      ...config,
      vpcOrigin: {
        type: "alb-vpc",
        albArn: mockAwsState.alb.arn,
        originProtocolPolicy: "http-only",
        albSecurityGroupIds: ["sg-alb-a"],
      },
      distributions: [
        {
          hostname: "app1.example.com",
          aliases: ["app2.example.com"],
          certificateArn: "arn:aws:acm:us-east-1:123456789012:certificate/example",
        },
      ],
    });

    expect(distributions[0]?.args).toMatchObject({
      aliases: ["app1.example.com", "app2.example.com"],
      origins: [
        {
          domainName: expect.objectContaining({ value: mockAwsState.alb.dnsName }),
          vpcOriginConfig: { vpcOriginId: expect.objectContaining({ value: "vo-123" }) },
          customHeaders: [{ name: "X-Reyem-Origin-Trial", value: "origin-secret" }],
        },
      ],
      defaultCacheBehavior: {
        cachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5a84be39ad",
      },
    });
    expect(originRequestPolicies[0]?.args.headersConfig).toEqual({
      headerBehavior: "allViewer",
    });
    expect(distributions[0]?.opts).toMatchObject({ dependsOn: [{}, {}] });
    expect(aliases.filter(({ args }) => args.type === "A").map(({ args }) => args.name)).toEqual([
      "app1.example.com",
      "app2.example.com",
    ]);
    expect(Object.keys(cdn.distributions).sort()).toEqual(["app1.example.com", "app2.example.com"]);
  });

  it("allows policy and method overrides on default and path behaviors", () => {
    createAwsCloudFront("prod", {
      ...config,
      distributions: [
        {
          ...publicDistribution,
          cachePolicyId: "default-cache",
          originRequestPolicyId: "default-origin-request",
          allowedMethods: ["GET", "HEAD", "OPTIONS", "POST"],
          cachedMethods: ["GET", "HEAD"],
          viewerProtocolPolicy: "https-only",
          orderedCacheBehaviors: [
            {
              pathPattern: "/api/*",
              cachePolicyId: "api-cache-disabled",
              originRequestPolicyId: "api-origin-request",
              allowedMethods: ["GET", "HEAD", "POST"],
              cachedMethods: ["GET", "HEAD"],
              viewerProtocolPolicy: "https-only",
            },
          ],
        },
      ],
    });

    expect(distributions[0]?.args.defaultCacheBehavior).toMatchObject({
      cachePolicyId: "default-cache",
      originRequestPolicyId: "default-origin-request",
      allowedMethods: ["GET", "HEAD", "OPTIONS", "POST"],
      cachedMethods: ["GET", "HEAD"],
      viewerProtocolPolicy: "https-only",
    });
    expect(distributions[0]?.args.orderedCacheBehaviors).toMatchObject([
      {
        cachePolicyId: "api-cache-disabled",
        originRequestPolicyId: "api-origin-request",
        allowedMethods: ["GET", "HEAD", "POST"],
        cachedMethods: ["GET", "HEAD"],
        viewerProtocolPolicy: "https-only",
      },
    ]);
  });

  it("rejects duplicate host aliases and cached methods outside allowed methods", () => {
    expect(() =>
      createAwsCloudFront("prod", {
        ...config,
        distributions: [
          {
            ...publicDistribution,
            aliases: ["www.reyem.tech"],
          },
        ],
      })
    ).toThrow(/configured more than once/);
    expect(() =>
      createAwsCloudFront("prod", {
        ...config,
        distributions: [
          {
            ...publicDistribution,
            allowedMethods: ["GET"],
            cachedMethods: ["GET", "HEAD"],
          },
        ],
      })
    ).toThrow(/cached methods must be included in allowed methods/);
  });

  it.each([
    [
      "public ALB",
      () => {
        mockAwsState.alb.internal = false;
      },
      /must be internal/,
    ],
    [
      "non-application load balancer",
      () => {
        mockAwsState.alb.loadBalancerType = "network";
      },
      /Application Load Balancer/,
    ],
    [
      "unsupported region",
      () => {
        mockAwsState.alb.region = "moon-1";
      },
      /not supported in ALB region/,
    ],
    [
      "excluded AZ in us-east-1",
      () => {
        mockAwsState.subnet.availabilityZoneId = "use1-az3";
      },
      /unavailable CloudFront VPC Origin AZ/,
    ],
    [
      "excluded AZ in us-west-1",
      () => {
        mockAwsState.alb.region = "us-west-1";
        mockAwsState.subnet.availabilityZoneId = "usw1-az2";
      },
      /unavailable CloudFront VPC Origin AZ/,
    ],
    [
      "excluded AZ in ap-northeast-1",
      () => {
        mockAwsState.alb.region = "ap-northeast-1";
        mockAwsState.subnet.availabilityZoneId = "apne1-az3";
      },
      /unavailable CloudFront VPC Origin AZ/,
    ],
    [
      "excluded AZ in ca-central-1",
      () => {
        mockAwsState.alb.region = "ca-central-1";
        mockAwsState.subnet.availabilityZoneId = "cac1-az3";
      },
      /unavailable CloudFront VPC Origin AZ/,
    ],
    [
      "full subnet",
      () => {
        mockAwsState.subnet.availableIpAddressCount = 0;
      },
      /available IPv4/,
    ],
    [
      "public subnet route",
      () => {
        mockAwsState.routeTable.routes = [
          { cidrBlock: "0.0.0.0/0", ipv6CidrBlock: "", gatewayId: "igw-123" },
        ];
      },
      /must be private/,
    ],
    [
      "missing VPC internet gateway",
      () => {
        mockAwsState.internetGateway.attachments = [];
      },
      /internet gateway/,
    ],
    [
      "missing managed security group",
      () => {
        mockAwsState.managedSecurityGroups.ids = [];
      },
      /CloudFront-VPCOrigins-Service-SG/,
    ],
    [
      "missing ALB security group",
      () => {
        mockAwsState.alb.securityGroups = [];
      },
      /at least one security group/,
    ],
  ])("rejects an ineligible ALB origin (%s)", (_caseName, configure, message) => {
    (configure as () => void)();
    expect(() =>
      createAwsCloudFront("prod", {
        ...config,
        vpcOrigin: {
          type: "alb-vpc",
          albArn: mockAwsState.alb.arn,
          originProtocolPolicy: "http-only",
          albSecurityGroupIds: ["sg-alb-a"],
        },
      })
    ).toThrow(message as RegExp);
  });

  it("requires explicit IDs for multiple ALB security groups and rejects unattached IDs", () => {
    expect(() =>
      createAwsCloudFront("prod", {
        ...config,
        vpcOrigin: { type: "alb-vpc", albArn: mockAwsState.alb.arn },
      })
    ).toThrow(/provide albSecurityGroupIds/);

    expect(() =>
      createAwsCloudFront("prod", {
        ...config,
        vpcOrigin: {
          type: "alb-vpc",
          albArn: mockAwsState.alb.arn,
          albSecurityGroupIds: ["sg-not-attached"],
        },
      })
    ).toThrow(/not attached to the ALB/);
  });

  it("opens both listener ports for match-viewer and validates configured ports", () => {
    createAwsCloudFront("prod", {
      ...config,
      vpcOrigin: {
        type: "alb-vpc",
        albArn: mockAwsState.alb.arn,
        albSecurityGroupIds: ["sg-alb-a"],
        originProtocolPolicy: "match-viewer",
      },
    });
    expect(securityGroupRules.map(({ args }) => args.fromPort)).toEqual([80, 443]);

    expect(() =>
      createAwsCloudFront("prod", {
        ...config,
        vpcOrigin: {
          type: "alb-vpc",
          albArn: mockAwsState.alb.arn,
          securityGroupPort: 0,
        },
      })
    ).toThrow(/securityGroupPort must be an integer from 1 to 65535/);
  });

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
      orderedCacheBehaviors: [
        {
          allowedMethods: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
          cachedMethods: ["GET", "HEAD"],
          cachePolicyId: "4135ea2d-6df8-44a3-9df3-4b5e77f2f582",
          originRequestPolicyId: "0887d865-4f00-4e99-a2c8-5c2e2b8ee5a7",
          pathPattern: "/booking-confirmed*",
          targetOriginId: "prod-www-reyem-tech-origin",
          viewerProtocolPolicy: "redirect-to-https",
        },
      ],
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
