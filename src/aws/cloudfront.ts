/**
 * AWS CloudFront implementation for the trusted application edge.
 *
 * @module aws/cloudfront
 */

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { ICdn, ICdnConfig } from "../cdn";
import { ConfigError, resolveCloudTarget } from "../types";

const DEFAULT_CLIENT_HOST_HEADER = "X-Reyem-Client-Host";
const FORWARDED_HEADER_PREFIX = "x-forwarded-";
const RESERVED_HEADER_PREFIX = "x-edge-";
const MANAGED_CACHING_OPTIMIZED_POLICY_ID = "658327ea-f89d-4fab-a63d-7e88639e58f6";
const MANAGED_CACHING_DISABLED_POLICY_ID = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";
const DEFAULT_ALLOWED_METHODS = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"];
const DEFAULT_CACHED_METHODS = ["GET", "HEAD"];
const VPC_ORIGIN_MANAGED_SECURITY_GROUP = "CloudFront-VPCOrigins-Service-SG";
const VPC_ORIGIN_SUPPORTED_REGIONS = new Set([
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "af-south-1",
  "ap-east-1",
  "ap-east-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-northeast-3",
  "ap-south-1",
  "ap-south-2",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-southeast-3",
  "ap-southeast-4",
  "ap-southeast-5",
  "ap-southeast-6",
  "ap-southeast-7",
  "ca-central-1",
  "ca-west-1",
  "eu-central-1",
  "eu-central-2",
  "eu-north-1",
  "eu-south-1",
  "eu-south-2",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "il-central-1",
  "me-central-1",
  "me-south-1",
  "mx-central-1",
  "sa-east-1",
]);
const UNAVAILABLE_AZ_IDS: Readonly<Record<string, string>> = {
  "us-east-1": "use1-az3",
  "us-west-1": "usw1-az2",
  "ap-northeast-1": "apne1-az3",
  "ca-central-1": "cac1-az3",
};

interface IVpcOriginResources {
  readonly resource: aws.cloudfront.VpcOrigin;
  readonly albDnsName: pulumi.Output<string>;
  readonly securityGroupRules: ReadonlyArray<aws.ec2.SecurityGroupRule>;
}

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

  const vpcOrigin = config.vpcOrigin ? createVpcOrigin(name, config.vpcOrigin) : undefined;

  const originRequestPolicy = new aws.cloudfront.OriginRequestPolicy(`${name}-origin-request`, {
    cookiesConfig: { cookieBehavior: "all" },
    headersConfig: {
      headerBehavior: vpcOrigin ? "allViewer" : "allExcept",
      headers: vpcOrigin ? undefined : { items: ["Host"] },
    },
    queryStringsConfig: { queryStringBehavior: "all" },
  });

  const createdDistributions = config.distributions.map((distribution) => {
    const resourceName = `${name}-${toResourceName(distribution.hostname)}`;
    const originId = `${resourceName}-origin`;
    const aliases = [distribution.hostname, ...(distribution.aliases ?? [])];
    const defaultCachePolicyId =
      distribution.cachePolicyId ??
      (vpcOrigin ? MANAGED_CACHING_DISABLED_POLICY_ID : MANAGED_CACHING_OPTIMIZED_POLICY_ID);
    const defaultOriginRequestPolicyId =
      distribution.originRequestPolicyId ?? originRequestPolicy.id;
    const defaultAllowedMethods = distribution.allowedMethods ?? DEFAULT_ALLOWED_METHODS;
    const defaultCachedMethods = distribution.cachedMethods ?? DEFAULT_CACHED_METHODS;
    const defaultViewerProtocolPolicy = distribution.viewerProtocolPolicy ?? "redirect-to-https";
    const domainName = vpcOrigin?.albDnsName ?? distribution.originDomainName;
    if (!domainName) {
      throw new ConfigError(
        `Distribution "${distribution.hostname}" requires originDomainName unless a shared vpcOrigin is configured`,
        "CONFIG_MISSING",
        "originDomainName"
      );
    }
    const resource = new aws.cloudfront.Distribution(
      resourceName,
      {
        aliases,
        enabled: true,
        isIpv6Enabled: true,
        origins: [
          {
            domainName,
            originId,
            customHeaders: vpcOrigin
              ? [{ name: config.originSecretHeader, value: config.originSecretValue }]
              : [
                  { name: config.originSecretHeader, value: config.originSecretValue },
                  { name: clientHostHeader, value: distribution.hostname },
                ],
            ...(vpcOrigin
              ? { vpcOriginConfig: { vpcOriginId: vpcOrigin.resource.id } }
              : {
                  customOriginConfig: {
                    httpPort: 80,
                    httpsPort: 443,
                    originProtocolPolicy: "https-only",
                    originSslProtocols: ["TLSv1.2"],
                  },
                }),
          },
        ],
        defaultCacheBehavior: {
          allowedMethods: [...defaultAllowedMethods],
          cachedMethods: [...defaultCachedMethods],
          cachePolicyId: defaultCachePolicyId,
          originRequestPolicyId: defaultOriginRequestPolicyId,
          targetOriginId: originId,
          viewerProtocolPolicy: defaultViewerProtocolPolicy,
        },
        orderedCacheBehaviors: distribution.orderedCacheBehaviors?.map((behavior) => ({
          allowedMethods: [...(behavior.allowedMethods ?? defaultAllowedMethods)],
          cachedMethods: [...(behavior.cachedMethods ?? defaultCachedMethods)],
          cachePolicyId: behavior.cachePolicyId ?? defaultCachePolicyId,
          originRequestPolicyId: behavior.originRequestPolicyId ?? defaultOriginRequestPolicyId,
          pathPattern: behavior.pathPattern,
          targetOriginId: originId,
          viewerProtocolPolicy: behavior.viewerProtocolPolicy ?? defaultViewerProtocolPolicy,
        })),
        priceClass: "PriceClass_100",
        restrictions: { geoRestriction: { restrictionType: "none" } },
        webAclId: config.webAclArn,
        viewerCertificate: {
          acmCertificateArn: distribution.certificateArn,
          minimumProtocolVersion: "TLSv1.2_2021",
          sslSupportMethod: "sni-only",
        },
        tags: { ...(config.tags ?? {}), Name: resourceName },
      },
      vpcOrigin ? { dependsOn: [vpcOrigin.resource, ...vpcOrigin.securityGroupRules] } : undefined
    );

    return [aliases, resource.domainName] as const;
  });
  const distributions = Object.fromEntries(
    createdDistributions.flatMap(([hosts, domainName]) =>
      hosts.map((hostname) => [hostname, domainName])
    )
  );

  const aliases = Object.fromEntries(
    config.distributions.flatMap((distribution) => {
      const cloudFrontDistribution = distributions[distribution.hostname];
      if (!cloudFrontDistribution) {
        throw new ConfigError(
          `CloudFront distribution for "${distribution.hostname}" was not created`,
          "CONFIG_INVALID",
          "distributions"
        );
      }

      return [distribution.hostname, ...(distribution.aliases ?? [])].map((hostname) => {
        const aliasResourceName = `${name}-${toResourceName(hostname)}`;
        const a = createAliasRecord(
          `${aliasResourceName}-a`,
          hostname,
          "A",
          config.hostedZoneId,
          cloudFrontDistribution
        );
        const aaaa = createAliasRecord(
          `${aliasResourceName}-aaaa`,
          hostname,
          "AAAA",
          config.hostedZoneId,
          cloudFrontDistribution
        );
        return [hostname, { a: a.fqdn, aaaa: aaaa.fqdn }];
      });
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

function createVpcOrigin(
  name: string,
  config: NonNullable<ICdnConfig["vpcOrigin"]>
): IVpcOriginResources {
  const alb = aws.lb.getLoadBalancerOutput({ arn: config.albArn });
  const subnets = alb.apply((loadBalancer) =>
    pulumi.all(
      loadBalancer.subnets.map((id) => aws.ec2.getSubnetOutput({ id, region: loadBalancer.region }))
    )
  );
  const routeTables = pulumi
    .all([alb, subnets])
    .apply(([loadBalancer, subnetResults]) =>
      pulumi.all(
        subnetResults.map((subnet) =>
          aws.ec2.getRouteTableOutput({ subnetId: subnet.id, region: loadBalancer.region })
        )
      )
    );
  const internetGateway = alb.apply((loadBalancer) =>
    aws.ec2.getInternetGatewayOutput({
      filters: [{ name: "attachment.vpc-id", values: [loadBalancer.vpcId] }],
      region: loadBalancer.region,
    })
  );
  const configuredSecurityGroupIds = pulumi.all<pulumi.Input<string>>([
    ...(config.albSecurityGroupIds ?? []),
  ]);
  const validation = pulumi
    .all([alb, subnets, routeTables, internetGateway, configuredSecurityGroupIds])
    .apply(([loadBalancer, subnetResults, routeTableResults, gateway, groupIds]) => {
      validateVpcOriginLoadBalancer(
        loadBalancer,
        subnetResults,
        routeTableResults,
        gateway,
        groupIds
      );
      return { arn: loadBalancer.arn };
    });

  const originProtocolPolicy = config.originProtocolPolicy ?? "https-only";
  const httpPort = config.httpPort ?? 80;
  const httpsPort = config.httpsPort ?? 443;
  const resource = new aws.cloudfront.VpcOrigin(`${name}-vpc-origin`, {
    vpcOriginEndpointConfig: {
      name: `${name}-vpc-origin`.slice(0, 64),
      arn: validation.apply(({ arn }) => arn),
      httpPort,
      httpsPort,
      originProtocolPolicy,
      originSslProtocols: { items: ["TLSv1.2"], quantity: 1 },
    },
  });

  const managedSecurityGroupIds = aws.ec2
    .getSecurityGroupsOutput(
      {
        filters: [
          { name: "group-name", values: [VPC_ORIGIN_MANAGED_SECURITY_GROUP] },
          { name: "vpc-id", values: [alb.apply((loadBalancer) => loadBalancer.vpcId)] },
        ],
        region: alb.apply((loadBalancer) => loadBalancer.region),
      },
      { dependsOn: [resource] }
    )
    .apply(({ ids }) => ids)
    .apply((ids) => {
      if (ids.length !== 1) {
        throw new ConfigError(
          `Expected one AWS-managed ${VPC_ORIGIN_MANAGED_SECURITY_GROUP} security group for ALB VPC origin, found ${ids.length}`,
          "CONFIG_INVALID",
          "vpcOrigin.albArn"
        );
      }
      const id = ids[0];
      if (!id) {
        throw new ConfigError(
          `AWS-managed ${VPC_ORIGIN_MANAGED_SECURITY_GROUP} lookup returned no security group ID`,
          "CONFIG_INVALID",
          "vpcOrigin.albArn"
        );
      }
      return id;
    });

  const ports = config.securityGroupPort
    ? [config.securityGroupPort]
    : originProtocolPolicy === "match-viewer"
      ? [...new Set([httpPort, httpsPort])]
      : [originProtocolPolicy === "http-only" ? httpPort : httpsPort];
  const securityGroupIds: ReadonlyArray<pulumi.Input<string>> = config.albSecurityGroupIds?.length
    ? config.albSecurityGroupIds
    : [
        alb.apply((loadBalancer) => {
          if (loadBalancer.securityGroups.length !== 1) {
            throw new ConfigError(
              "ALB has multiple security groups; provide albSecurityGroupIds to select which group receives CloudFront ingress",
              "CONFIG_INVALID",
              "vpcOrigin.albSecurityGroupIds"
            );
          }
          const securityGroupId = loadBalancer.securityGroups[0];
          if (!securityGroupId) {
            throw new ConfigError(
              "ALB has no security group to allow CloudFront VPC Origin traffic",
              "CONFIG_INVALID",
              "vpcOrigin.albSecurityGroupIds"
            );
          }
          return securityGroupId;
        }),
      ];
  const securityGroupRules = securityGroupIds.flatMap((securityGroupId, index) =>
    ports.map(
      (port) =>
        new aws.ec2.SecurityGroupRule(
          `${name}-cloudfront-origin-${index}-${port}`,
          {
            type: "ingress",
            protocol: "tcp",
            fromPort: port,
            toPort: port,
            securityGroupId,
            sourceSecurityGroupId: managedSecurityGroupIds,
            description: "Allow CloudFront VPC Origin traffic to the private ALB",
          },
          { dependsOn: [resource] }
        )
    )
  );

  return {
    resource,
    albDnsName: alb.apply((loadBalancer) => loadBalancer.dnsName),
    securityGroupRules,
  };
}

function validateVpcOriginLoadBalancer(
  loadBalancer: aws.lb.GetLoadBalancerResult,
  subnets: aws.ec2.GetSubnetResult[],
  routeTables: aws.ec2.GetRouteTableResult[],
  internetGateway: aws.ec2.GetInternetGatewayResult,
  configuredSecurityGroupIds: string[]
): void {
  if (loadBalancer.loadBalancerType !== "application") {
    throw new ConfigError(
      `CloudFront VPC Origin ALB ARN "${loadBalancer.arn}" must identify an Application Load Balancer`,
      "CONFIG_INVALID",
      "vpcOrigin.albArn"
    );
  }
  if (!loadBalancer.internal) {
    throw new ConfigError(
      `CloudFront VPC Origin ALB "${loadBalancer.arn}" must be internal; internet-facing ALBs are not eligible`,
      "CONFIG_INVALID",
      "vpcOrigin.albArn"
    );
  }
  if (loadBalancer.securityGroups.length === 0) {
    throw new ConfigError(
      `CloudFront VPC Origin ALB "${loadBalancer.arn}" must have at least one security group`,
      "CONFIG_INVALID",
      "vpcOrigin.albArn"
    );
  }
  if (configuredSecurityGroupIds.length === 0 && loadBalancer.securityGroups.length > 1) {
    throw new ConfigError(
      "ALB has multiple security groups; provide albSecurityGroupIds to select which group receives CloudFront ingress",
      "CONFIG_INVALID",
      "vpcOrigin.albSecurityGroupIds"
    );
  }
  const unattachedSecurityGroup = configuredSecurityGroupIds.find(
    (securityGroupId) => !loadBalancer.securityGroups.includes(securityGroupId)
  );
  if (unattachedSecurityGroup) {
    throw new ConfigError(
      `Configured ALB security group "${unattachedSecurityGroup}" is not attached to the ALB`,
      "CONFIG_INVALID",
      "vpcOrigin.albSecurityGroupIds"
    );
  }
  if (!VPC_ORIGIN_SUPPORTED_REGIONS.has(loadBalancer.region)) {
    throw new ConfigError(
      `CloudFront VPC Origins are not supported in ALB region "${loadBalancer.region}"`,
      "CONFIG_INVALID",
      "vpcOrigin.albArn"
    );
  }
  if (subnets.length === 0 || subnets.length !== routeTables.length) {
    throw new ConfigError(
      `CloudFront VPC Origin ALB "${loadBalancer.arn}" must use private subnets with route tables`,
      "CONFIG_INVALID",
      "vpcOrigin.albArn"
    );
  }
  for (const [index, subnet] of subnets.entries()) {
    if (subnet.vpcId !== loadBalancer.vpcId) {
      throw new ConfigError(
        `ALB subnet "${subnet.id}" is not in the load balancer VPC "${loadBalancer.vpcId}"`,
        "CONFIG_INVALID",
        "vpcOrigin.albArn"
      );
    }
    if (subnet.availableIpAddressCount < 1) {
      throw new ConfigError(
        `ALB subnet "${subnet.id}" needs at least one available IPv4 address for a CloudFront VPC Origin`,
        "CONFIG_INVALID",
        "vpcOrigin.albArn"
      );
    }
    const unavailableAz = UNAVAILABLE_AZ_IDS[loadBalancer.region];
    if (subnet.availabilityZoneId === unavailableAz) {
      throw new ConfigError(
        `ALB subnet "${subnet.id}" is in unavailable CloudFront VPC Origin AZ "${subnet.availabilityZoneId}" for region "${loadBalancer.region}"`,
        "CONFIG_INVALID",
        "vpcOrigin.albArn"
      );
    }
    const hasInternetGatewayRoute = routeTables[index]?.routes.some(
      (route) =>
        (route.cidrBlock === "0.0.0.0/0" || route.ipv6CidrBlock === "::/0") &&
        route.gatewayId.startsWith("igw-")
    );
    if (hasInternetGatewayRoute) {
      throw new ConfigError(
        `ALB subnet "${subnet.id}" must be private for a CloudFront VPC Origin`,
        "CONFIG_INVALID",
        "vpcOrigin.albArn"
      );
    }
  }
  if (!internetGateway.attachments.some((attachment) => attachment.vpcId === loadBalancer.vpcId)) {
    throw new ConfigError(
      `VPC "${loadBalancer.vpcId}" must have an attached internet gateway for a CloudFront VPC Origin`,
      "CONFIG_INVALID",
      "vpcOrigin.albArn"
    );
  }
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
  if (config.vpcOrigin) {
    const protocol = config.vpcOrigin.originProtocolPolicy ?? "https-only";
    if (!["http-only", "https-only", "match-viewer"].includes(protocol)) {
      throw new ConfigError(
        `Unsupported CloudFront VPC Origin protocol policy "${protocol}"`,
        "CONFIG_INVALID",
        "vpcOrigin.originProtocolPolicy"
      );
    }
    for (const [key, port] of [
      ["httpPort", config.vpcOrigin.httpPort ?? 80],
      ["httpsPort", config.vpcOrigin.httpsPort ?? 443],
      ["securityGroupPort", config.vpcOrigin.securityGroupPort],
    ] as const) {
      if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
        throw new ConfigError(
          `CloudFront VPC Origin ${key} must be an integer from 1 to 65535`,
          "CONFIG_INVALID",
          `vpcOrigin.${key}`
        );
      }
    }
  }

  if (!config.vpcOrigin) {
    const missingOrigin = config.distributions.find(({ originDomainName }) => !originDomainName);
    if (missingOrigin) {
      throw new ConfigError(
        `Distribution "${missingOrigin.hostname}" requires originDomainName unless a shared vpcOrigin is configured`,
        "CONFIG_MISSING",
        "originDomainName"
      );
    }
  }

  const hostnames = new Set<string>();
  for (const distribution of config.distributions) {
    const aliases = [distribution.hostname, ...(distribution.aliases ?? [])];
    for (const alias of aliases) {
      const hostname = alias.toLowerCase();
      if (hostname !== alias || hostname.includes(":")) {
        throw new ConfigError(
          `Distribution hostname "${alias}" must be a lowercase hostname without a port`,
          "CONFIG_INVALID",
          "distributions"
        );
      }
      if (hostnames.has(hostname)) {
        throw new ConfigError(
          `CloudFront alias "${alias}" is configured more than once`,
          "CONFIG_INVALID",
          "distributions"
        );
      }
      hostnames.add(hostname);
    }

    validateCachedMethods(
      distribution.allowedMethods ?? DEFAULT_ALLOWED_METHODS,
      distribution.cachedMethods ?? DEFAULT_CACHED_METHODS,
      `distributions.${distribution.hostname}`
    );
    for (const behavior of distribution.orderedCacheBehaviors ?? []) {
      validateCachedMethods(
        behavior.allowedMethods ?? distribution.allowedMethods ?? DEFAULT_ALLOWED_METHODS,
        behavior.cachedMethods ?? distribution.cachedMethods ?? DEFAULT_CACHED_METHODS,
        `distributions.${distribution.hostname}.orderedCacheBehaviors.${behavior.pathPattern}`
      );
    }
  }
}

function validateCachedMethods(
  allowedMethods: ReadonlyArray<string>,
  cachedMethods: ReadonlyArray<string>,
  configKey: string
): void {
  const allowed = new Set(allowedMethods);
  const invalidMethod = cachedMethods.find((method) => !allowed.has(method));
  if (invalidMethod) {
    throw new ConfigError(
      `CloudFront cached methods must be included in allowed methods; "${invalidMethod}" is not allowed`,
      "CONFIG_INVALID",
      configKey
    );
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
