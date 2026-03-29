/**
 * Backup target module — S3-backed backup destinations with IAM credentials
 * and optional cross-region replication.
 *
 * @module backup
 */

import * as aws from "@pulumi/aws";
import * as pulumi from "@pulumi/pulumi";
import type { IBackupTarget, IBackupTargetConfig } from "./interfaces";

export type { IBackupReplicationConfig, IBackupTargetConfig, IBackupTarget } from "./interfaces";

/**
 * Create an S3-backed backup target with IAM credentials.
 *
 * Provisions an S3 bucket with versioning, an IAM user scoped to that bucket,
 * and optionally a replica bucket in another region for cross-region replication.
 *
 * @param name - Logical name prefix for all created resources
 * @param config - Backup target configuration
 * @returns IBackupTarget with bucket name, credentials, and optional replica bucket
 */
export function createBackupTarget(name: string, config: IBackupTargetConfig): IBackupTarget {
  const bucketName = config.bucketPrefix ? `${config.bucketPrefix}-${name}` : name;
  const providerOpts: pulumi.CustomResourceOptions = config.awsProvider
    ? { provider: config.awsProvider }
    : {};

  // Primary bucket
  const bucket = new aws.s3.Bucket(
    `${name}-bucket`,
    {
      bucket: bucketName,
      tags: config.tags,
    },
    providerOpts
  );

  // Enable versioning on the primary bucket
  new aws.s3.BucketVersioning(
    `${name}-bucket-versioning`,
    {
      bucket: bucket.bucket,
      versioningConfiguration: {
        status: "Enabled",
      },
    },
    { ...providerOpts, dependsOn: [bucket] }
  );

  // IAM user for backup credentials
  const iamUser = new aws.iam.User(
    `${name}-backup-user`,
    {
      name: `nimbus-backup-${name}`,
      path: "/nimbus/",
      tags: config.tags,
    },
    providerOpts
  );

  // IAM policy scoped to the bucket
  const iamPolicy = new aws.iam.Policy(
    `${name}-backup-policy`,
    {
      name: `nimbus-backup-${name}`,
      description: `Nimbus backup policy for bucket ${bucketName}`,
      policy: pulumi.all([bucket.arn]).apply(([bucketArn]) =>
        JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
              Resource: `${bucketArn}/*`,
            },
            {
              Effect: "Allow",
              Action: ["s3:ListBucket"],
              Resource: bucketArn,
            },
          ],
        })
      ),
      tags: config.tags,
    },
    providerOpts
  );

  // Attach policy to user
  new aws.iam.UserPolicyAttachment(
    `${name}-backup-policy-attachment`,
    {
      user: iamUser.name,
      policyArn: iamPolicy.arn,
    },
    { ...providerOpts, dependsOn: [iamUser, iamPolicy] }
  );

  // IAM access key
  const accessKey = new aws.iam.AccessKey(
    `${name}-backup-access-key`,
    {
      user: iamUser.name,
    },
    { ...providerOpts, dependsOn: [iamUser] }
  );

  // Optional: cross-region replication
  let replicationBucket: pulumi.Output<string> | undefined;

  if (config.replication?.enabled) {
    const replicaRegion = config.replication.targetRegion;

    // Create a provider for the replica region
    const replicaProvider = new aws.Provider(`${name}-replica-provider`, {
      region: replicaRegion as aws.Region,
    });

    const replicaBucketName = `${bucketName}-replica`;
    const replicaBucketResource = new aws.s3.Bucket(
      `${name}-replica-bucket`,
      {
        bucket: replicaBucketName,
        tags: config.tags,
      },
      { provider: replicaProvider }
    );

    // Enable versioning on replica (required for replication)
    new aws.s3.BucketVersioning(
      `${name}-replica-bucket-versioning`,
      {
        bucket: replicaBucketResource.bucket,
        versioningConfiguration: {
          status: "Enabled",
        },
      },
      { provider: replicaProvider, dependsOn: [replicaBucketResource] }
    );

    // IAM role for replication
    const replicationRole = new aws.iam.Role(
      `${name}-replication-role`,
      {
        name: `nimbus-replication-${name}`,
        assumeRolePolicy: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "s3.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
        tags: config.tags,
      },
      providerOpts
    );

    // Replication role policy
    const replicationPolicy = new aws.iam.RolePolicy(
      `${name}-replication-policy`,
      {
        role: replicationRole.name,
        policy: pulumi.all([bucket.arn, replicaBucketResource.arn]).apply(([srcArn, dstArn]) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Action: [
                  "s3:GetReplicationConfiguration",
                  "s3:ListBucket",
                ],
                Resource: srcArn,
              },
              {
                Effect: "Allow",
                Action: [
                  "s3:GetObjectVersionForReplication",
                  "s3:GetObjectVersionAcl",
                  "s3:GetObjectVersionTagging",
                ],
                Resource: `${srcArn}/*`,
              },
              {
                Effect: "Allow",
                Action: [
                  "s3:ReplicateObject",
                  "s3:ReplicateDelete",
                  "s3:ReplicateTags",
                ],
                Resource: `${dstArn}/*`,
              },
            ],
          })
        ),
      },
      { ...providerOpts, dependsOn: [replicationRole] }
    );

    // Bucket replication configuration
    new aws.s3.BucketReplicationConfig(
      `${name}-replication-config`,
      {
        bucket: bucket.bucket,
        role: replicationRole.arn,
        rules: [
          {
            id: `${name}-replicate-all`,
            status: "Enabled",
            destination: {
              bucket: replicaBucketResource.arn,
              storageClass: "STANDARD",
            },
            filter: {
              prefix: "",
            },
            deleteMarkerReplication: {
              status: "Enabled",
            },
          },
        ],
      },
      { ...providerOpts, dependsOn: [bucket, replicaBucketResource, replicationPolicy] }
    );

    replicationBucket = replicaBucketResource.bucket;
  }

  return {
    name,
    bucket: bucket.bucket,
    region: config.region,
    credentials: {
      accessKeyId: accessKey.id,
      secretAccessKey: accessKey.secret,
    },
    replicationBucket,
    nativeResource: bucket,
  };
}
