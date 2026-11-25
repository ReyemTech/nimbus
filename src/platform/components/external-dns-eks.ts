import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { IExternalDnsConfig } from "../interfaces";
import type { ICluster } from "../../cluster";

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
