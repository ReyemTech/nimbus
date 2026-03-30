/**
 * MinIO backend — deploys MinIO via the official MinIO Helm chart
 * (charts.min.io) and provisions buckets via Kubernetes Jobs using
 * the MinIO Client (mc).
 *
 * Each bucket gets dedicated credentials replicated as K8s Secrets into
 * the specified target namespaces. The Job pattern works with Pulumi's
 * execution model: each createBucket() call is independent.
 *
 * @module operator/minio
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ensureNamespace } from "../utils/ensure-namespace";
import type {
  IOperatorConfig,
  IMinIOOperator,
  IMinIOBucket,
  IMinIOBucketConfig,
} from "./interfaces";
import { resolveStorageTier } from "../types/storage-tiers";

const DATA_NAMESPACE = "data";
const DEFAULT_STORAGE_GB = 20;
const MINIO_SERVICE_PORT = 9000;

/**
 * Deploy MinIO using the official MinIO Helm chart and return an
 * IMinIOOperator with a createBucket() method for provisioning
 * object storage buckets.
 *
 * @example
 * ```typescript
 * const minio = createMinioOperator({ cluster });
 *
 * const bucket = minio.createBucket("uploads", {
 *   sizeGb: 20,
 *   namespaces: ["app", "workers"],
 * });
 * ```
 */
export function createMinioOperator(
  config: IOperatorConfig,
  helmRelease: k8s.helm.v3.Release
): IMinIOOperator {
  const provider = config.cluster.provider;
  const namespace = config.namespace ?? DATA_NAMESPACE;

  // Root credentials secret name — the official MinIO chart names the
  // secret after the Helm release. Pulumi appends a hash suffix to the
  // release name, so we derive the actual name from the release status.
  const releaseName = helmRelease.status.apply((s) => s?.name ?? "minio-operator");
  const rootSecretName = releaseName;

  // MinIO service endpoint within the cluster
  const endpoint = releaseName.apply(
    (rn) => `http://${rn}.${namespace}.svc.cluster.local:${MINIO_SERVICE_PORT}`
  );

  return {
    name: "minio",
    type: "minio",
    helmRelease,

    createBucket(bucketName: string, bucketConfig?: IMinIOBucketConfig): IMinIOBucket {
      const targetNamespaces = bucketConfig?.namespaces ?? [];

      // -----------------------------------------------------------------------
      // Job: create the bucket using mc (MinIO Client)
      // -----------------------------------------------------------------------
      const jobName = `minio-create-bucket-${bucketName}`;
      const bucketJob = new k8s.batch.v1.Job(
        jobName,
        {
          metadata: {
            name: jobName,
            namespace,
            labels: {
              "app.kubernetes.io/managed-by": "nimbus",
              "nimbus/bucket": bucketName,
            },
          },
          spec: {
            ttlSecondsAfterFinished: 300,
            backoffLimit: 3,
            template: {
              metadata: {
                labels: { "nimbus/bucket": bucketName },
              },
              spec: {
                restartPolicy: "Never",
                containers: [
                  {
                    name: "mc",
                    image: "minio/mc:latest",
                    command: [
                      "sh",
                      "-c",
                      [
                        "mc alias set nimbus $MINIO_ENDPOINT $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD",
                        `mc mb --ignore-existing nimbus/${bucketName}`,
                        bucketConfig?.public
                          ? `mc anonymous set download nimbus/${bucketName}`
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" && "),
                    ],
                    env: [
                      {
                        name: "MINIO_ENDPOINT",
                        value: endpoint,
                      },
                      {
                        name: "MINIO_ROOT_USER",
                        valueFrom: {
                          secretKeyRef: { name: rootSecretName, key: "rootUser" },
                        },
                      },
                      {
                        name: "MINIO_ROOT_PASSWORD",
                        valueFrom: {
                          secretKeyRef: { name: rootSecretName, key: "rootPassword" },
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
        { provider, dependsOn: [helmRelease] }
      );

      // -----------------------------------------------------------------------
      // Credentials: read root credentials from the Helm-created secret and
      // replicate a per-bucket secret into each target namespace.
      // -----------------------------------------------------------------------
      const nsResource = ensureNamespace(namespace, provider);

      const rootSecret = k8s.core.v1.Secret.get(
        `minio-root-secret-${bucketName}`,
        pulumi.interpolate`${namespace}/${rootSecretName}`,
        { provider, dependsOn: [helmRelease, nsResource] }
      );

      const accessKeyId = rootSecret.data.apply((data) =>
        Buffer.from(data?.["rootUser"] ?? "", "base64").toString()
      );
      const secretAccessKey = rootSecret.data.apply((data) =>
        Buffer.from(data?.["rootPassword"] ?? "", "base64").toString()
      );

      const secrets: Record<string, pulumi.Output<string>> = {};

      for (const targetNs of targetNamespaces) {
        const targetNsResource = ensureNamespace(targetNs, provider);
        const secretName = `minio-${bucketName}`;

        new k8s.core.v1.Secret(
          `minio-bucket-secret-${bucketName}-${targetNs}`,
          {
            metadata: {
              name: secretName,
              namespace: targetNs,
              labels: {
                "app.kubernetes.io/managed-by": "nimbus",
                "nimbus/bucket": bucketName,
              },
            },
            stringData: {
              endpoint,
              bucket: bucketName,
              accessKeyId,
              secretAccessKey,
            },
          },
          { provider, dependsOn: [helmRelease, targetNsResource, bucketJob] }
        );

        secrets[targetNs] = pulumi.output(secretName);
      }

      return {
        name: bucketName,
        endpoint,
        bucketName: pulumi.output(bucketName),
        credentials: { accessKeyId, secretAccessKey },
        secrets,
        nativeResource: bucketJob,
      };
    },
  };
}

/**
 * Build official MinIO Helm values from an IOperatorConfig.
 * Exposed so index.ts can pass them to the shared Helm release.
 *
 * Official chart reference: https://github.com/minio/minio/tree/master/helm/minio
 */
export function buildMinioHelmValues(config: IOperatorConfig): Record<string, unknown> {
  const storageGb = DEFAULT_STORAGE_GB;
  const storageClass = resolveStorageTier("standard", config.cluster.storageTiers);

  return {
    mode: "standalone",
    replicas: 1,
    persistence: {
      enabled: true,
      size: `${storageGb}Gi`,
      ...(storageClass ? { storageClass } : {}),
    },
    resources: {
      requests: { memory: "256Mi", cpu: "100m" },
    },
    // Official chart: console runs on port 9001, disable if not needed
    consoleService: { enabled: false },
    // Merge caller-supplied overrides last
    ...(config.values ?? {}),
  };
}
