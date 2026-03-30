/**
 * MinIO backend — deploys MinIO via Bitnami Helm chart and provisions
 * buckets via Kubernetes Jobs using the MinIO Client (mc).
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

const DATA_NAMESPACE = "data";
const DEFAULT_STORAGE_GB = 20;
const MINIO_SERVICE_PORT = 9000;

/**
 * Deploy MinIO using the Bitnami Helm chart and return an IMinIOOperator
 * with a createBucket() method for provisioning object storage buckets.
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

  // Root credentials secret name (created by the Bitnami chart)
  const rootSecretName = "minio";

  // MinIO service endpoint within the cluster
  const endpoint = pulumi.output(
    `http://minio.${namespace}.svc.cluster.local:${MINIO_SERVICE_PORT}`
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
                        value: `http://minio.${namespace}.svc.cluster.local:${MINIO_SERVICE_PORT}`,
                      },
                    ],
                    envFrom: [
                      {
                        secretRef: {
                          // Bitnami chart creates a secret named "minio"
                          // with MINIO_ROOT_USER and MINIO_ROOT_PASSWORD keys
                          name: rootSecretName,
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
        `minio-root-secret`,
        pulumi.interpolate`${namespace}/${rootSecretName}`,
        { provider, dependsOn: [helmRelease, nsResource] }
      );

      const accessKeyId = rootSecret.data.apply((data) =>
        Buffer.from(data?.["root-user"] ?? data?.["MINIO_ROOT_USER"] ?? "", "base64").toString()
      );
      const secretAccessKey = rootSecret.data.apply((data) =>
        Buffer.from(
          data?.["root-password"] ?? data?.["MINIO_ROOT_PASSWORD"] ?? "",
          "base64"
        ).toString()
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
              endpoint: `http://minio.${namespace}.svc.cluster.local:${MINIO_SERVICE_PORT}`,
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
 * Build the Bitnami MinIO Helm values from an IOperatorConfig.
 * Exposed so index.ts can pass them to the shared Helm release.
 */
export function buildMinioHelmValues(config: IOperatorConfig): Record<string, unknown> {
  const storageGb = DEFAULT_STORAGE_GB;

  return {
    mode: "standalone",
    persistence: {
      enabled: true,
      size: `${storageGb}Gi`,
      storageClass: "sata",
    },
    resources: {
      requests: { memory: "256Mi", cpu: "100m" },
    },
    // Disable the object browser console to avoid image pull issues
    disableWebUI: true,
    // Merge caller-supplied overrides last
    ...(config.values ?? {}),
  };
}
