import * as aws from "@pulumi/aws";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IClusterConfig, IKarpenterNodePool, IManagedNodePool } from "../cluster";
import type { INetwork } from "../network";
import type { IEksOptions } from "./cluster";

const STABLE_LABEL = "nimbus.dev/node-pool";
const KARPENTER_VERSION = "1.15.3";

export function isKarpenterPool(
  pool: IClusterConfig["nodePools"][number]
): pool is IKarpenterNodePool {
  return pool.scaling?.mode === "karpenter";
}

export function isManagedPool(pool: IClusterConfig["nodePools"][number]): pool is IManagedNodePool {
  return pool.scaling?.mode !== "karpenter";
}

/** Reject unsafe or ambiguous autoscaler ownership before registering AWS resources. */
export function validateEksNodePoolScaling(config: IClusterConfig, options: IEksOptions): void {
  const names = new Set<string>();
  const controllersEnabled = config.nodePools.some(
    (pool) => pool.scaling?.mode === "cluster-autoscaler" || isKarpenterPool(pool)
  );
  for (const pool of config.nodePools) {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(pool.name)) {
      throw new Error(
        `Node pool name "${pool.name}" must use lowercase letters, numbers, and hyphens.`
      );
    }
    if (names.has(pool.name)) throw new Error(`Duplicate node pool name "${pool.name}".`);
    names.add(pool.name);
    if (controllersEnabled && pool.labels?.[STABLE_LABEL] !== undefined) {
      throw new Error(`The label "${STABLE_LABEL}" is reserved by Nimbus.`);
    }
    if (isKarpenterPool(pool) && pool.scaling.instanceTypes.length === 0) {
      throw new Error(
        `Karpenter node pool "${pool.name}" must specify at least one instance type.`
      );
    }
    if (isManagedPool(pool) && (pool.minNodes < 0 || pool.maxNodes < pool.minNodes)) {
      throw new Error(
        `Node pool "${pool.name}" must have nonnegative minNodes and maxNodes >= minNodes.`
      );
    }
    if (isManagedPool(pool) && pool.scaling?.mode === "fixed") {
      const count = pool.desiredNodes ?? pool.minNodes;
      if (count < 0 || count > pool.maxNodes) {
        throw new Error(
          `Fixed node pool "${pool.name}" desiredNodes must be between 0 and maxNodes.`
        );
      }
    }
  }
  const caPools = config.nodePools.filter((pool) => pool.scaling?.mode === "cluster-autoscaler");
  const hasKarpenter = config.nodePools.some(isKarpenterPool);
  const hasController = caPools.length > 0 || hasKarpenter;
  if (options.autoMode && hasController) {
    throw new Error("Cluster Autoscaler and Karpenter cannot be combined with EKS Auto Mode.");
  }
  if (hasKarpenter && options.authenticationMode === "CONFIG_MAP") {
    throw new Error(
      "Karpenter requires EKS API authentication to register its EC2_LINUX node access entry."
    );
  }
  if (hasController) {
    const stable = config.nodePools.find(
      (pool) => pool.name === options.autoscalerControllerNodePoolName
    );
    if (!stable || !isManagedPool(stable) || stable.minNodes < 1 || stable.spot === true) {
      throw new Error(
        "autoscalerControllerNodePoolName must name an on-demand managed node pool with minNodes >= 1."
      );
    }
  }
}

/** Provision cluster-scoped autoscaler controllers and per-pool resources. */
export function createEksAutoscaling(
  name: string,
  cluster: aws.eks.Cluster,
  provider: k8s.Provider,
  network: INetwork,
  pools: IClusterConfig["nodePools"],
  options: IEksOptions,
  nodeGroupsByPool: ReadonlyMap<string, aws.eks.NodeGroup>,
  podIdentityAgent: aws.eks.Addon | undefined,
  region: string,
  kubernetesVersion: pulumi.Input<string>,
  tags: Readonly<Record<string, string>>
): pulumi.Resource[] {
  const resources: pulumi.Resource[] = [];
  const caPools = pools.filter((pool) => pool.scaling?.mode === "cluster-autoscaler");
  const karpenterPools = pools.filter(isKarpenterPool);
  const stablePool = options.autoscalerControllerNodePoolName;
  const stableSelector = { matchLabels: { [STABLE_LABEL]: stablePool ?? "" } };
  const stablePoolConfig = pools.find((pool) => pool.name === stablePool);
  const stablePoolGuaranteedNodes =
    stablePoolConfig && isManagedPool(stablePoolConfig)
      ? stablePoolConfig.scaling?.mode === "fixed"
        ? (stablePoolConfig.desiredNodes ?? stablePoolConfig.minNodes)
        : stablePoolConfig.minNodes
      : 1;
  const controllerReplicas = stablePoolGuaranteedNodes >= 2 ? 2 : 1;
  if (caPools.length) {
    const role = createPodRole(`${name}-cluster-autoscaler`, tags);
    const policy = new aws.iam.RolePolicy(`${name}-cluster-autoscaler-policy`, {
      role: role.name,
      policy: pulumi.all([cluster.name]).apply(([clusterName]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: [
                "autoscaling:DescribeAutoScalingGroups",
                "autoscaling:DescribeAutoScalingInstances",
                "autoscaling:DescribeLaunchConfigurations",
                "autoscaling:DescribeScalingActivities",
                "autoscaling:DescribeTags",
                "ec2:DescribeLaunchTemplateVersions",
                "ec2:DescribeInstanceTypes",
                "eks:DescribeNodegroup",
              ],
              Resource: "*",
            },
            {
              Effect: "Allow",
              Action: [
                "autoscaling:SetDesiredCapacity",
                "autoscaling:TerminateInstanceInAutoScalingGroup",
              ],
              Resource: "*",
              Condition: {
                StringEquals: {
                  [`autoscaling:ResourceTag/k8s.io/cluster-autoscaler/${clusterName}`]: "owned",
                },
              },
            },
          ],
        })
      ),
    });
    const association = new aws.eks.PodIdentityAssociation(
      `${name}-cluster-autoscaler-identity`,
      {
        clusterName: cluster.name,
        namespace: "kube-system",
        serviceAccount: "cluster-autoscaler",
        roleArn: role.arn,
      },
      { dependsOn: [cluster, policy, ...(podIdentityAgent ? [podIdentityAgent] : [])] }
    );
    resources.push(role, policy, association);
    for (const pool of caPools) {
      const group = nodeGroupsByPool.get(pool.name);
      if (!group)
        throw new Error(`Cluster Autoscaler pool "${pool.name}" has no managed node group.`);
      resources.push(
        new aws.autoscaling.Tag(
          `${name}-ca-tag-${pool.name}-enabled`,
          {
            autoscalingGroupName: group.resources.apply(
              (items) => items[0]?.autoscalingGroups[0]?.name ?? ""
            ),
            tag: {
              key: "k8s.io/cluster-autoscaler/enabled",
              value: "true",
              propagateAtLaunch: false,
            },
          },
          { dependsOn: [group] }
        )
      );
      resources.push(
        new aws.autoscaling.Tag(
          `${name}-ca-tag-${pool.name}-cluster`,
          {
            autoscalingGroupName: group.resources.apply(
              (items) => items[0]?.autoscalingGroups[0]?.name ?? ""
            ),
            tag: {
              key: `k8s.io/cluster-autoscaler/${name}`,
              value: "owned",
              propagateAtLaunch: false,
            },
          },
          { dependsOn: [group] }
        )
      );
    }
    const caNodeGroups = caPools.flatMap((pool) => {
      const group = nodeGroupsByPool.get(pool.name);
      return group ? [group] : [];
    });
    const chart = new k8s.helm.v3.Chart(
      `${name}-cluster-autoscaler`,
      {
        chart: "cluster-autoscaler",
        version:
          options.clusterAutoscaler?.version ??
          pulumi
            .all([kubernetesVersion])
            .apply(([clusterVersion]) => clusterAutoscalerChartVersion(clusterVersion ?? "")),
        namespace: "kube-system",
        fetchOpts: { repo: "https://kubernetes.github.io/autoscaler" },
        values: {
          autoDiscovery: { clusterName: name },
          awsRegion: region,
          rbac: { serviceAccount: { create: true, name: "cluster-autoscaler" } },
          nodeSelector: stableSelector.matchLabels,
          extraArgs: {
            "skip-nodes-with-local-storage": "false",
            "balance-similar-node-groups": "true",
          },
        },
      },
      { provider, dependsOn: [association, ...caNodeGroups] }
    );
    resources.push(chart as unknown as pulumi.Resource);
  }
  if (karpenterPools.length) {
    const namespace = options.karpenter?.namespace ?? "karpenter";
    const usesSpot = karpenterPools.some((pool) => pool.scaling.capacityTypes?.includes("spot"));
    const interruptionEnabled = usesSpot && options.karpenter?.interruptionHandling !== false;
    const interruptionQueue = interruptionEnabled
      ? new aws.sqs.Queue(`${name}-karpenter-interruption`, {
          messageRetentionSeconds: 300,
          sqsManagedSseEnabled: true,
          tags,
        })
      : undefined;
    if (interruptionQueue) {
      const patterns = [
        { source: ["aws.ec2"], "detail-type": ["EC2 Spot Instance Interruption Warning"] },
        { source: ["aws.ec2"], "detail-type": ["EC2 Instance Rebalance Recommendation"] },
        {
          source: ["aws.ec2"],
          "detail-type": ["EC2 Instance State-change Notification"],
        },
        { source: ["aws.health"], "detail-type": ["AWS Health Event"] },
        {
          source: ["aws.ec2"],
          "detail-type": ["EC2 Capacity Reservation Instance Interruption Warning"],
        },
      ];
      const rules = patterns.map(
        (pattern, index) =>
          new aws.cloudwatch.EventRule(`${name}-karpenter-interruption-${index}`, {
            eventPattern: JSON.stringify(pattern),
            tags,
          })
      );
      const accountId = cluster.arn.apply((arn) => arn.split(":")[4] ?? "*");
      const queuePolicy = new aws.sqs.QueuePolicy(`${name}-karpenter-interruption-policy`, {
        queueUrl: interruptionQueue.url,
        policy: pulumi.all([interruptionQueue.arn, accountId]).apply(([queueArn, account]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { Service: "events.amazonaws.com" },
                Action: "sqs:SendMessage",
                Resource: queueArn,
                Condition: {
                  ArnLike: {
                    "aws:SourceArn": `arn:aws:events:*:${account}:rule/${name}-karpenter-interruption-*`,
                  },
                },
              },
            ],
          })
        ),
      });
      const targets = rules.map(
        (rule, index) =>
          new aws.cloudwatch.EventTarget(
            `${name}-karpenter-interruption-target-${index}`,
            {
              rule: rule.name,
              arn: interruptionQueue.arn,
            },
            { dependsOn: [queuePolicy] }
          )
      );
      resources.push(interruptionQueue, queuePolicy, ...rules, ...targets);
    }
    const nodeRole = new aws.iam.Role(`${name}-karpenter-node-role`, {
      namePrefix: `${name}-karpenter-node-`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
      tags,
    });
    const role = createPodRole(`${name}-karpenter-controller`, tags);
    const policy = new aws.iam.RolePolicy(`${name}-karpenter-controller-policy`, {
      role: role.name,
      policy: pulumi
        .all([cluster.arn, nodeRole.arn, interruptionQueue?.arn ?? ""])
        .apply(([clusterArn, workerRoleArn, queueArn]) =>
          buildKarpenterControllerPolicy(
            clusterArn,
            workerRoleArn,
            queueArn,
            name,
            region,
            interruptionEnabled
          )
        ),
    });
    const association = new aws.eks.PodIdentityAssociation(
      `${name}-karpenter-identity`,
      {
        clusterName: cluster.name,
        namespace,
        serviceAccount: "karpenter",
        roleArn: role.arn,
      },
      { dependsOn: [cluster, policy, ...(podIdentityAgent ? [podIdentityAgent] : [])] }
    );
    const nodeAttachments = [
      "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
      "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
      "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPullOnly",
    ].map(
      (policyArn) =>
        new aws.iam.RolePolicyAttachment(`${name}-karpenter-node-${policyArn.split("/").pop()}`, {
          role: nodeRole.name,
          policyArn,
        })
    );
    const access = new aws.eks.AccessEntry(
      `${name}-karpenter-node-access`,
      {
        clusterName: cluster.name,
        principalArn: nodeRole.arn,
        type: "EC2_LINUX",
        tags,
      },
      { dependsOn: [cluster, nodeRole, ...nodeAttachments] }
    );
    const karpenterRelease = new k8s.helm.v3.Release(
      `${name}-karpenter`,
      {
        chart: "oci://public.ecr.aws/karpenter/karpenter",
        version: options.karpenter?.version ?? KARPENTER_VERSION,
        namespace,
        createNamespace: true,
        values: {
          settings: {
            clusterName: name,
            clusterEndpoint: cluster.endpoint,
            interruptionQueue: interruptionQueue?.name,
            eksControlPlane: true,
          },
          serviceAccount: { create: true, name: "karpenter" },
          nodeSelector: stableSelector.matchLabels,
          controller: {
            env: [{ name: "AWS_REGION", value: region }],
          },
          replicas: controllerReplicas,
        },
      },
      {
        provider,
        dependsOn: [
          association,
          access,
          ...nodeAttachments,
          ...(podIdentityAgent ? [podIdentityAgent] : []),
          ...nodeGroupsByPool.values(),
        ],
      }
    );
    resources.push(
      role,
      policy,
      association,
      nodeRole,
      ...nodeAttachments,
      access,
      karpenterRelease as unknown as pulumi.Resource
    );
    const nodeClass = new k8s.apiextensions.CustomResource(
      `${name}-karpenter-nodeclass`,
      {
        apiVersion: "karpenter.k8s.aws/v1",
        kind: "EC2NodeClass",
        metadata: { name: "nimbus-default" },
        spec: {
          role: nodeRole.name,
          amiSelectorTerms: [{ alias: "al2023@latest" }],
          subnetSelectorTerms: pulumi
            .all([
              network.privateSubnetIds,
              network.privateSubnetAvailabilityZones ?? pulumi.output([] as string[]),
            ])
            .apply(([ids, zones]) => {
              const requested = new Set(
                karpenterPools.flatMap((pool) => pool.scaling.availabilityZones ?? [])
              );
              if (requested.size && !network.privateSubnetAvailabilityZones) {
                throw new Error(
                  "Karpenter availabilityZones require a Nimbus AWS network with private-subnet AZ metadata."
                );
              }
              const missing = [...requested].filter((zone) => !zones.includes(zone));
              if (missing.length)
                throw new Error(
                  `Karpenter availability zones are outside Nimbus private subnets: ${missing.join(", ")}.`
                );
              // A NodeClass is shared across pools. Keep every private subnet
              // available here; each NodePool's topology requirement applies
              // its own optional AZ restriction.
              return ids.map((id) => ({ id }));
            }),
          securityGroupSelectorTerms: [
            { id: cluster.vpcConfig.apply((v) => v.clusterSecurityGroupId) },
          ],
        },
      },
      { provider, dependsOn: [karpenterRelease, access, network.nativeResource] }
    );
    resources.push(nodeClass);
    for (const pool of karpenterPools) {
      resources.push(
        new k8s.apiextensions.CustomResource(
          `${name}-karpenter-pool-${pool.name}`,
          {
            apiVersion: "karpenter.sh/v1",
            kind: "NodePool",
            metadata: { name: pool.name },
            spec: {
              template: {
                metadata: { labels: { ...(pool.labels ?? {}), [STABLE_LABEL]: pool.name } },
                spec: {
                  nodeClassRef: {
                    group: "karpenter.k8s.aws",
                    kind: "EC2NodeClass",
                    name: "nimbus-default",
                  },
                  taints: pool.taints?.map((taint) => ({
                    ...taint,
                    effect: taint.effect === "NoExecute" ? "NoExecute" : taint.effect,
                  })),
                  requirements: [
                    {
                      key: "node.kubernetes.io/instance-type",
                      operator: "In",
                      values: [...pool.scaling.instanceTypes],
                    },
                    {
                      key: "karpenter.sh/capacity-type",
                      operator: "In",
                      values: [...(pool.scaling.capacityTypes ?? ["on-demand"])],
                    },
                    ...(pool.scaling.availabilityZones
                      ? [
                          {
                            key: "topology.kubernetes.io/zone",
                            operator: "In",
                            values: [...pool.scaling.availabilityZones],
                          },
                        ]
                      : []),
                  ],
                },
              },
              limits: pool.scaling.limits,
              disruption: { consolidationPolicy: "WhenEmpty", consolidateAfter: "1m" },
            },
          },
          { provider, dependsOn: [nodeClass] }
        )
      );
    }
  }
  return resources;
}

function clusterAutoscalerChartVersion(kubernetesVersion: string): string {
  const minor = /^1\.(\d+)(?:\.|$)/.exec(kubernetesVersion)?.[1];
  const versions: Record<string, string> = {
    "29": "9.35.0",
    "30": "9.37.0",
    "31": "9.38.0",
    "32": "9.46.6",
    "33": "9.47.0",
    "34": "9.51.0",
    "35": "9.54.0",
    "36": "9.60.0",
  };
  if (!minor || !versions[minor]) {
    throw new Error(
      `No pinned Cluster Autoscaler chart mapping is available for Kubernetes ${kubernetesVersion}; set clusterAutoscaler.version explicitly.`
    );
  }
  return versions[minor];
}

function createPodRole(name: string, tags: Readonly<Record<string, string>>): aws.iam.Role {
  return new aws.iam.Role(`${name}-role`, {
    namePrefix: `${name}-`,
    assumeRolePolicy: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "pods.eks.amazonaws.com" },
          Action: ["sts:AssumeRole", "sts:TagSession"],
        },
      ],
    }),
    tags,
  });
}

function buildKarpenterControllerPolicy(
  clusterArn: string,
  workerRoleArn: string,
  queueArn: string,
  clusterName: string,
  region: string,
  interruptionEnabled: boolean
): string {
  const [, partition = "aws", , , account = "*"] = clusterArn.split(":");
  const ec2Arn = `arn:${partition}:ec2:${region}:`;
  const instanceProfileArn = `arn:${partition}:iam::${account}:instance-profile/*`;
  const nodePoolTag = "karpenter.sh/nodepool";
  const resourceTags = {
    StringEquals: { [`aws:ResourceTag/kubernetes.io/cluster/${clusterName}`]: "owned" },
    StringLike: { [`aws:ResourceTag/${nodePoolTag}`]: "*" },
  };
  const requestTags = {
    StringEquals: {
      [`aws:RequestTag/kubernetes.io/cluster/${clusterName}`]: "owned",
      "aws:RequestTag/eks:eks-cluster-name": clusterName,
    },
    StringLike: { [`aws:RequestTag/${nodePoolTag}`]: "*" },
  };
  const profileRequestTags = {
    StringEquals: {
      [`aws:RequestTag/kubernetes.io/cluster/${clusterName}`]: "owned",
      "aws:RequestTag/eks:eks-cluster-name": clusterName,
      "aws:RequestTag/topology.kubernetes.io/region": region,
    },
    StringLike: { "aws:RequestTag/karpenter.k8s.aws/ec2nodeclass": "*" },
  };
  const launchResources = [
    `${ec2Arn}*:fleet/*`,
    `${ec2Arn}*:instance/*`,
    `${ec2Arn}*:volume/*`,
    `${ec2Arn}*:network-interface/*`,
    `${ec2Arn}*:launch-template/*`,
    `${ec2Arn}*:spot-instances-request/*`,
  ];
  const statements: Array<Record<string, unknown>> = [
    {
      Effect: "Allow",
      Action: ["ec2:RunInstances", "ec2:CreateFleet"],
      Resource: [
        `arn:${partition}:ec2:${region}::image/*`,
        `${ec2Arn}*:snapshot/*`,
        `${ec2Arn}*:security-group/*`,
        `${ec2Arn}*:subnet/*`,
        `${ec2Arn}*:capacity-reservation/*`,
        `${ec2Arn}*:placement-group/*`,
      ],
    },
    {
      Effect: "Allow",
      Action: ["ec2:RunInstances", "ec2:CreateFleet"],
      Resource: `${ec2Arn}*:launch-template/*`,
      Condition: resourceTags,
    },
    {
      Effect: "Allow",
      Action: ["ec2:RunInstances", "ec2:CreateFleet", "ec2:CreateLaunchTemplate"],
      Resource: launchResources,
      Condition: requestTags,
    },
    {
      Effect: "Allow",
      Action: "ec2:CreateTags",
      Resource: launchResources,
      Condition: {
        ...requestTags,
        StringEquals: {
          ...requestTags.StringEquals,
          "ec2:CreateAction": ["RunInstances", "CreateFleet", "CreateLaunchTemplate"],
        },
      },
    },
    {
      Effect: "Allow",
      Action: "ec2:CreateTags",
      Resource: `${ec2Arn}*:instance/*`,
      Condition: {
        ...resourceTags,
        StringEqualsIfExists: { "aws:RequestTag/eks:eks-cluster-name": clusterName },
        "ForAllValues:StringEquals": {
          "aws:TagKeys": ["eks:eks-cluster-name", "karpenter.sh/nodeclaim", "Name"],
        },
      },
    },
    {
      Effect: "Allow",
      Action: ["ec2:TerminateInstances", "ec2:RebootInstances", "ec2:DeleteLaunchTemplate"],
      Resource: [`${ec2Arn}*:instance/*`, `${ec2Arn}*:launch-template/*`],
      Condition: resourceTags,
    },
    {
      Effect: "Allow",
      Action: "iam:PassRole",
      Resource: workerRoleArn,
      Condition: {
        StringEquals: { "iam:PassedToService": ["ec2.amazonaws.com", "ec2.amazonaws.com.cn"] },
      },
    },
    {
      Effect: "Allow",
      Action: "iam:CreateInstanceProfile",
      Resource: instanceProfileArn,
      Condition: profileRequestTags,
    },
    {
      Effect: "Allow",
      Action: "iam:TagInstanceProfile",
      Resource: instanceProfileArn,
      Condition: {
        StringEquals: {
          [`aws:ResourceTag/kubernetes.io/cluster/${clusterName}`]: "owned",
          "aws:ResourceTag/topology.kubernetes.io/region": region,
          ...profileRequestTags.StringEquals,
        },
        StringLike: {
          "aws:ResourceTag/karpenter.k8s.aws/ec2nodeclass": "*",
          ...profileRequestTags.StringLike,
        },
      },
    },
    {
      Effect: "Allow",
      Action: [
        "iam:AddRoleToInstanceProfile",
        "iam:RemoveRoleFromInstanceProfile",
        "iam:DeleteInstanceProfile",
      ],
      Resource: instanceProfileArn,
      Condition: {
        StringEquals: {
          [`aws:ResourceTag/kubernetes.io/cluster/${clusterName}`]: "owned",
          "aws:ResourceTag/topology.kubernetes.io/region": region,
        },
        StringLike: { "aws:ResourceTag/karpenter.k8s.aws/ec2nodeclass": "*" },
      },
    },
    { Effect: "Allow", Action: "iam:GetInstanceProfile", Resource: instanceProfileArn },
    { Effect: "Allow", Action: "iam:ListInstanceProfiles", Resource: "*" },
    {
      Effect: "Allow",
      Action: [
        "ec2:DescribeCapacityReservations",
        "ec2:DescribeImages",
        "ec2:DescribeInstances",
        "ec2:DescribeInstanceStatus",
        "ec2:DescribeInstanceTypeOfferings",
        "ec2:DescribeInstanceTypes",
        "ec2:DescribeLaunchTemplates",
        "ec2:DescribePlacementGroups",
        "ec2:DescribeSecurityGroups",
        "ec2:DescribeSpotPriceHistory",
        "ec2:DescribeSubnets",
      ],
      Resource: "*",
      Condition: { StringEquals: { "aws:RequestedRegion": region } },
    },
    {
      Effect: "Allow",
      Action: "ssm:GetParameter",
      Resource: `arn:${partition}:ssm:${region}::parameter/aws/service/*`,
    },
    { Effect: "Allow", Action: "pricing:GetProducts", Resource: "*" },
    { Effect: "Allow", Action: "eks:DescribeCluster", Resource: clusterArn },
  ];
  if (interruptionEnabled) {
    statements.push({
      Effect: "Allow",
      Action: ["sqs:DeleteMessage", "sqs:GetQueueUrl", "sqs:ReceiveMessage"],
      Resource: queueArn,
    });
  }
  return JSON.stringify({ Version: "2012-10-17", Statement: statements });
}
