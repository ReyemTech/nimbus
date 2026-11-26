import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IExternalDnsConfig, IRoute53PrivateHostedZoneConfig } from "../interfaces";
import type { ICluster } from "../../cluster";
import { ensureNamespace } from "../../utils/ensure-namespace";
import {
  DEFAULT_PRIVATE_DNS_PREFIX,
  externalDnsVisibilityFilter,
  route53PrivateZoneName,
} from "./route53-private-dns";

/** Provision the Route 53 identity and community add-on for an EKS cluster. */
export function deployEksExternalDns(
  name: string,
  cluster: ICluster,
  config: IExternalDnsConfig,
  awsProvider?: pulumi.ProviderResource,
  certManagerServiceAccountName: pulumi.Input<string> = "cert-manager"
): {
  addon: aws.eks.Addon;
  certManagerIdentity: aws.eks.PodIdentityAssociation;
  podIdentityAgent: aws.eks.Addon | pulumi.Resource;
} {
  const eks = cluster.nativeResource as aws.eks.Cluster;
  const tags = cluster.awsResourceTags;
  // AWS's selected add-on schema rejects this upstream ExternalDNS flag.
  // Zone writes remain scoped by the IAM policy built from hostedZoneIds.
  const configurationOverrides = Object.fromEntries(
    Object.entries(config.values ?? {}).filter(([key]) => key !== "zoneIdFilters")
  );
  const opts = awsProvider ? { provider: awsProvider } : {};
  const podIdentityAgent =
    cluster.providerResources?.podIdentityAgent ??
    new aws.eks.Addon(
      `${name}-addon-eks-pod-identity-agent`,
      { clusterName: eks.name, addonName: "eks-pod-identity-agent", tags },
      { ...opts, dependsOn: [eks] }
    );
  const zones = resolveZones(name, config, opts);
  const role = new aws.iam.Role(
    `${name}-external-dns-role`,
    {
      assumeRolePolicy: pulumi
        .all([eks.arn, aws.getCallerIdentityOutput({}, opts).accountId])
        .apply(([clusterArn, accountId]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "pods.eks.amazonaws.com" },
                Action: ["sts:AssumeRole", "sts:TagSession"],
                Condition: {
                  StringEquals: { "aws:SourceAccount": accountId },
                  ArnEquals: { "aws:SourceArn": clusterArn },
                },
              },
            ],
          })
        ),
      tags,
    },
    opts
  );
  const policy = new aws.iam.RolePolicy(
    `${name}-external-dns-policy`,
    {
      role: role.id,
      policy: pulumi.output(zones).apply((resolvedZones) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["route53:ChangeResourceRecordSets"],
              Resource: resolvedZones.arns,
            },
            {
              Effect: "Allow",
              Action: ["route53:ListResourceRecordSets"],
              // ExternalDNS discovers matching hosted zones before listing their records.
              // Keep discovery functional even when other zones are filtered out by domain.
              Resource: "*",
            },
            {
              Effect: "Allow",
              Action: ["route53:ListHostedZones", "route53:ListHostedZonesByName"],
              Resource: "*",
            },
            {
              Effect: "Allow",
              Action: ["route53:GetChange"],
              Resource: "arn:aws:route53:::change/*",
            },
          ],
        })
      ),
    },
    opts
  );
  const addon = new aws.eks.Addon(
    `${name}-external-dns-addon`,
    {
      clusterName: eks.name,
      addonName: "external-dns",
      tags,
      addonVersion: config.addonVersion,
      configurationValues: pulumi.output(zones).apply(() =>
        JSON.stringify({
          domainFilters: config.domainFilters ?? [],
          policy: "sync",
          sources: ["ingress", "service", "traefik-proxy"],
          registry: "txt",
          ...configurationOverrides,
        })
      ),
      podIdentityAssociations: [{ roleArn: role.arn, serviceAccount: "external-dns" }],
      resolveConflictsOnCreate: "OVERWRITE",
      resolveConflictsOnUpdate: "OVERWRITE",
    },
    {
      ...opts,
      dependsOn: [eks, podIdentityAgent, policy],
    }
  );
  const certManagerIdentity = new aws.eks.PodIdentityAssociation(
    `${name}-cert-manager-route53-identity`,
    {
      clusterName: eks.name,
      namespace: "cert-manager",
      serviceAccount: certManagerServiceAccountName,
      roleArn: role.arn,
      tags,
    },
    { ...opts, dependsOn: [eks, podIdentityAgent, policy] }
  );
  return { addon, certManagerIdentity, podIdentityAgent };
}

interface IResolvedPrivateZone {
  readonly id: pulumi.Input<string>;
  readonly domainFilter: string;
}

export interface IEksExternalDnsSplitResources {
  readonly releases: readonly [k8s.helm.v3.Release, k8s.helm.v3.Release];
  readonly privateZones: ReadonlyArray<aws.route53.Zone | aws.route53.ZoneAssociation>;
  readonly identities: ReadonlyArray<aws.eks.PodIdentityAssociation>;
  readonly certManagerIdentity: aws.eks.PodIdentityAssociation;
  readonly podIdentityAgent: aws.eks.Addon | pulumi.Resource;
}

/** Provision split Route 53 controllers when EKS needs public and private Ingress DNS. */
export function deployEksExternalDnsSplit(
  name: string,
  cluster: ICluster,
  domain: string,
  config: IExternalDnsConfig,
  k8sProvider: k8s.Provider,
  awsProvider?: pulumi.ProviderResource,
  certManagerServiceAccountName: pulumi.Input<string> = "cert-manager"
): IEksExternalDnsSplitResources {
  const route53Config = config.route53;
  const privateZoneConfigs = route53Config?.privateHostedZones ?? [];
  if (config.dnsProvider !== "route53") {
    throw new Error("Private hosted zones are supported only with the Route 53 DNS provider");
  }
  if (privateZoneConfigs.length === 0) {
    throw new Error("Split Route 53 DNS requires at least one privateHostedZones entry");
  }
  if (!config.hostedZoneIds?.length || !config.domainFilters?.length) {
    throw new Error("Split Route 53 DNS requires explicit public hostedZoneIds and domainFilters");
  }
  if (!cluster.awsVpcId || !cluster.awsRegion) {
    throw new Error(
      "Split Route 53 DNS requires an AWS EKS cluster with its VPC ID and region exposed"
    );
  }
  const awsVpcId = cluster.awsVpcId;
  const clusterRegion = cluster.awsRegion;
  const publicDomainFilters = config.domainFilters;

  const opts = awsProvider ? { provider: awsProvider } : {};
  const eks = cluster.nativeResource as aws.eks.Cluster;
  const tags = cluster.awsResourceTags;
  const annotation = route53Config?.ingressVisibilityAnnotation ?? "nimbus.dev/dns-visibility";
  const publicZoneIds = [...config.hostedZoneIds];
  const privateZones: Array<aws.route53.Zone | aws.route53.ZoneAssociation> = [];
  const resolvedPrivateZones: IResolvedPrivateZone[] = [];

  const plannedPrivateFilters = privateZoneConfigs.map((zoneConfig) =>
    zoneConfig.mode === "create"
      ? route53PrivateZoneName(domain, zoneConfig.prefix ?? DEFAULT_PRIVATE_DNS_PREFIX)
      : zoneConfig.domainFilter
  );
  if (new Set(plannedPrivateFilters).size !== plannedPrivateFilters.length) {
    throw new Error("Split Route 53 DNS private hosted zones must have unique domain filters");
  }

  privateZoneConfigs.forEach((zoneConfig, index) => {
    const resolved = createOrReferencePrivateZone(
      name,
      domain,
      index,
      zoneConfig,
      awsVpcId,
      clusterRegion,
      opts,
      tags
    );
    if (resolved.resource) privateZones.push(resolved.resource);
    resolvedPrivateZones.push({ id: resolved.id, domainFilter: resolved.domainFilter });
  });

  const privateFilters = resolvedPrivateZones.map((zone) => zone.domainFilter);
  const podIdentityAgent =
    cluster.providerResources?.podIdentityAgent ??
    new aws.eks.Addon(
      `${name}-addon-eks-pod-identity-agent`,
      { clusterName: eks.name, addonName: "eks-pod-identity-agent", tags },
      { ...opts, dependsOn: [eks] }
    );

  const publicOwnerId = stringValue(config.values?.txtOwnerId) ?? "default";
  const privateOwnerId = route53Config?.privateTxtOwnerId ?? `${name}-external-dns-private`;
  const ownerIds = [publicOwnerId, privateOwnerId];
  if (new Set(ownerIds).size !== ownerIds.length) {
    throw new Error("Public and private ExternalDNS controllers require distinct TXT owner IDs");
  }
  const configuredPolicy = stringValue(config.values?.policy);
  const publicPolicy = configuredPolicy ?? "upsert-only";
  if (publicPolicy !== "sync" && publicPolicy !== "upsert-only") {
    throw new Error(
      "Split Route 53 DNS supports only `upsert-only` or explicitly configured `sync` policy"
    );
  }
  const privatePolicy = route53Config?.privatePolicy ?? "upsert-only";
  const controllerIds = {
    public: route53Config?.publicControllerId ?? `${name}-external-dns-public`,
    private: route53Config?.privateControllerId ?? `${name}-external-dns-private`,
  };
  if (new Set(Object.values(controllerIds)).size !== 2) {
    throw new Error("Public and private ExternalDNS controllers require distinct controller IDs");
  }

  const createIdentity = (
    identityName: string,
    namespace: string,
    serviceAccount: string,
    zoneIds: ReadonlyArray<pulumi.Input<string>>
  ) => {
    const role = new aws.iam.Role(
      `${identityName}-role`,
      {
        assumeRolePolicy: pulumi
          .all([eks.arn, aws.getCallerIdentityOutput({}, opts).accountId])
          .apply(([clusterArn, accountId]) =>
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "pods.eks.amazonaws.com" },
                  Action: ["sts:AssumeRole", "sts:TagSession"],
                  Condition: {
                    StringEquals: { "aws:SourceAccount": accountId },
                    ArnEquals: { "aws:SourceArn": clusterArn },
                  },
                },
              ],
            })
          ),
        tags,
      },
      opts
    );
    const policy = new aws.iam.RolePolicy(
      `${identityName}-policy`,
      {
        role: role.id,
        policy: pulumi.all([...zoneIds]).apply((ids) =>
          aws.getPartitionOutput({}, opts).apply((partition) =>
            JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Action: ["route53:ChangeResourceRecordSets"],
                  Resource: ids.map(
                    (id) => `arn:${partition.partition}:route53:::hostedzone/${id}`
                  ),
                },
                { Effect: "Allow", Action: ["route53:ListResourceRecordSets"], Resource: "*" },
                {
                  Effect: "Allow",
                  Action: ["route53:ListHostedZones", "route53:ListHostedZonesByName"],
                  Resource: "*",
                },
                {
                  Effect: "Allow",
                  Action: ["route53:GetChange"],
                  Resource: "arn:aws:route53:::change/*",
                },
              ],
            })
          )
        ),
      },
      opts
    );
    const identity = new aws.eks.PodIdentityAssociation(
      `${identityName}-identity`,
      {
        clusterName: eks.name,
        namespace,
        serviceAccount,
        roleArn: role.arn,
        tags,
      },
      { ...opts, dependsOn: [eks, podIdentityAgent, policy] }
    );
    return { role, policy, identity };
  };

  const namespaceNames: [string, string] = ["external-dns-public", "external-dns-private"];
  const namespaces: [pulumi.Resource, pulumi.Resource] = [
    ensureNamespace(namespaceNames[0], k8sProvider),
    ensureNamespace(namespaceNames[1], k8sProvider),
  ];
  const publicIdentity = createIdentity(
    `${name}-external-dns-public`,
    namespaceNames[0],
    namespaceNames[0],
    publicZoneIds
  );
  const privateIdentity = createIdentity(
    `${name}-external-dns-private`,
    namespaceNames[1],
    namespaceNames[1],
    resolvedPrivateZones.map((zone) => zone.id)
  );
  const certManagerIdentity = new aws.eks.PodIdentityAssociation(
    `${name}-cert-manager-route53-identity`,
    {
      clusterName: eks.name,
      namespace: "cert-manager",
      serviceAccount: certManagerServiceAccountName,
      roleArn: publicIdentity.role.arn,
      tags,
    },
    { ...opts, dependsOn: [eks, podIdentityAgent, publicIdentity.policy] }
  );

  const baseValues = Object.fromEntries(
    Object.entries(config.values ?? {}).filter(
      ([key]) =>
        ![
          "annotationFilter",
          "awsZoneType",
          "domainFilters",
          "extraArgs",
          "policy",
          "serviceAccount",
          "sources",
          "txtOwnerId",
          "zoneIdFilters",
        ].includes(key)
    )
  );
  const configuredEnv = Array.isArray(config.values?.env)
    ? config.values.env.filter(
        (entry): entry is Record<string, unknown> =>
          typeof entry === "object" && entry !== null && "name" in entry
      )
    : [];
  const awsRegion = config.awsRegion ?? clusterRegion;
  const makeRelease = (
    controller: "public" | "private",
    releaseName: string,
    namespace: string,
    namespaceResource: pulumi.Resource,
    identity: ReturnType<typeof createIdentity>,
    zoneIds: ReadonlyArray<pulumi.Input<string>>,
    domainFilters: ReadonlyArray<string>,
    sources: ReadonlyArray<string>,
    ownerId: string,
    policy: string,
    zoneType: "public" | "private",
    annotationFilter?: string
  ) => {
    const controllerId = controllerIds[controller];
    const extraArgs: Record<string, unknown> = {
      "aws-zone-type": zoneType,
      "zone-id-filter": pulumi
        .all([...zoneIds])
        .apply((ids) => ids.map((id) => `/hostedzone/${id}`)),
    };
    return new k8s.helm.v3.Release(
      releaseName,
      {
        chart: "external-dns",
        repositoryOpts: { repo: "https://kubernetes-sigs.github.io/external-dns" },
        version: config.version,
        namespace,
        createNamespace: false,
        values: {
          ...baseValues,
          provider: { name: "aws" },
          domainFilters: [...domainFilters],
          policy,
          sources: [...sources],
          registry: "txt",
          env: [
            ...configuredEnv.filter((entry) => entry.name !== "AWS_REGION"),
            { name: "AWS_REGION", value: awsRegion },
          ],
          txtOwnerId: ownerId,
          serviceAccount: { create: true, name: namespace },
          commonLabels: { "nimbus.dev/dns-controller": controllerId },
          extraArgs,
          ...(annotationFilter ? { annotationFilter } : {}),
        },
      },
      { provider: k8sProvider, dependsOn: [namespaceResource, identity.identity] }
    );
  };

  const releases = [
    makeRelease(
      "public",
      `${name}-external-dns-public`,
      namespaceNames[0],
      namespaces[0],
      publicIdentity,
      publicZoneIds,
      publicDomainFilters,
      ["ingress", "service", "traefik-proxy"],
      publicOwnerId,
      publicPolicy,
      "public",
      externalDnsVisibilityFilter(annotation, "public")
    ),
    makeRelease(
      "private",
      `${name}-external-dns-private`,
      namespaceNames[1],
      namespaces[1],
      privateIdentity,
      resolvedPrivateZones.map((zone) => zone.id),
      privateFilters,
      ["ingress"],
      privateOwnerId,
      privatePolicy,
      "private",
      externalDnsVisibilityFilter(annotation, "private")
    ),
  ] as const;

  return {
    releases,
    privateZones,
    identities: [publicIdentity.identity, privateIdentity.identity],
    certManagerIdentity,
    podIdentityAgent,
  };
}

function createOrReferencePrivateZone(
  name: string,
  domain: string,
  index: number,
  zoneConfig: IRoute53PrivateHostedZoneConfig,
  awsVpcId: pulumi.Input<string>,
  awsRegion: string,
  opts: pulumi.CustomResourceOptions,
  tags?: Readonly<Record<string, string>>
): {
  id: pulumi.Input<string>;
  domainFilter: string;
  resource?: aws.route53.Zone | aws.route53.ZoneAssociation;
} {
  if (zoneConfig.mode === "create") {
    const prefix = zoneConfig.prefix ?? DEFAULT_PRIVATE_DNS_PREFIX;
    const zoneName = route53PrivateZoneName(domain, prefix);
    const zone = new aws.route53.Zone(
      `${name}-private-zone-${prefix}`,
      {
        name: zoneName,
        comment: zoneConfig.comment ?? `Private DNS for ${name}`,
        vpcs: [{ vpcId: awsVpcId, vpcRegion: awsRegion }],
        tags,
      },
      opts
    );
    return { id: zone.zoneId, domainFilter: zoneName, resource: zone };
  }

  if (!zoneConfig.domainFilter.trim()) {
    throw new Error("Existing Route 53 private zones require an explicit domainFilter");
  }
  if (zoneConfig.associateClusterVpc) {
    const association = new aws.route53.ZoneAssociation(
      `${name}-private-zone-association-${index}`,
      {
        zoneId: zoneConfig.hostedZoneId,
        vpcId: awsVpcId,
        vpcRegion: awsRegion,
      },
      opts
    );
    return {
      id: zoneConfig.hostedZoneId,
      domainFilter: zoneConfig.domainFilter,
      resource: association,
    };
  }
  return { id: zoneConfig.hostedZoneId, domainFilter: zoneConfig.domainFilter };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface IResolvedRoute53Zones {
  readonly ids: string[];
  readonly arns: string[];
}

function resolveZones(
  name: string,
  config: IExternalDnsConfig,
  opts: pulumi.InvokeOutputOptions
): pulumi.Output<IResolvedRoute53Zones> {
  if (config.hostedZoneIds?.length) {
    return pulumi.all([...config.hostedZoneIds]).apply((ids) =>
      aws.getPartitionOutput({}, opts).apply((partition) => ({
        ids,
        arns: ids.map((id) => `arn:${partition.partition}:route53:::hostedzone/${id}`),
      }))
    );
  }
  const filters = config.domainFilters ?? [];
  if (!filters.length)
    throw new Error(
      "EKS ExternalDNS requires hostedZoneIds or non-empty domainFilters for scoped Route 53 access"
    );
  return pulumi
    .all([
      aws.getPartitionOutput({}, opts),
      pulumi.all(filters.map((domain) => aws.route53.getZoneOutput({ name: domain }, opts))),
    ])
    .apply(([partition, zones]) => {
      if (zones.some((zone) => !zone.zoneId))
        throw new Error(
          `${name}: unable to resolve all Route 53 zones; set externalDns.hostedZoneIds explicitly`
        );
      const ids = zones.map((zone) => zone.zoneId);
      return {
        ids,
        arns: ids.map((id) => `arn:${partition.partition}:route53:::hostedzone/${id}`),
      };
    });
}
