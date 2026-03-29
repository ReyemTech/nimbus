/**
 * Backup target interfaces for @reyemtech/nimbus.
 * @module backup/interfaces
 */
import type * as pulumi from "@pulumi/pulumi";

export interface IBackupReplicationConfig {
  readonly enabled: boolean;
  readonly targetRegion: string;
}

export interface IBackupTargetConfig {
  readonly cloud: "aws";
  readonly region: string;
  readonly bucketPrefix?: string;
  readonly replication?: IBackupReplicationConfig;
  readonly tags?: Record<string, string>;
  readonly awsProvider?: pulumi.ProviderResource;
}

export interface IBackupTarget {
  readonly name: string;
  readonly bucket: pulumi.Output<string>;
  readonly region: string;
  readonly credentials: {
    readonly accessKeyId: pulumi.Output<string>;
    readonly secretAccessKey: pulumi.Output<string>;
  };
  readonly replicationBucket?: pulumi.Output<string>;
  readonly nativeResource: pulumi.Resource;
}
