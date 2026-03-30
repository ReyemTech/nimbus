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

import * as crypto from "node:crypto";
import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import { ensureNamespace } from "../utils/ensure-namespace";
import type {
  IOperatorConfig,
  IMinIOOperator,
  IMinIOBucket,
  IMinIOBucketConfig,
  IMinIOIngressConfig,
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

  // MinIO S3 API endpoint within the cluster
  const endpoint = releaseName.apply(
    (rn) => `http://${rn}.${namespace}.svc.cluster.local:${MINIO_SERVICE_PORT}`
  );

  return {
    name: "minio",
    type: "minio",
    helmRelease,
    endpoint,

    createBucket(bucketName: string, bucketConfig?: IMinIOBucketConfig): IMinIOBucket {
      const targetNamespaces = bucketConfig?.namespaces ?? [];

      // Generate per-bucket credentials (20-char access key, 40-char secret)
      const bucketAccessKey = pulumi.secret(
        `nimbus-${bucketName}-${crypto.randomBytes(6).toString("hex")}`
      );
      const bucketSecretKey = pulumi.secret(
        crypto.randomBytes(30).toString("base64url")
      );

      // Store per-bucket credentials in a Secret in the data namespace
      // (the Job reads these to create the MinIO user)
      const credentialSecretName = `minio-${bucketName}-credentials`;
      const credentialSecret = new k8s.core.v1.Secret(
        `minio-${bucketName}-creds`,
        {
          metadata: {
            name: credentialSecretName,
            namespace,
            labels: {
              "app.kubernetes.io/managed-by": "nimbus",
              "nimbus/bucket": bucketName,
            },
          },
          stringData: {
            accessKey: bucketAccessKey,
            secretKey: bucketSecretKey,
          },
        },
        {
          provider,
          dependsOn: [helmRelease],
          // Credentials are generated once; ignore changes on subsequent runs
          // so crypto.randomBytes doesn't cause secret replacement every deploy.
          ignoreChanges: ["data", "stringData"],
        }
      );

      // IAM policy JSON granting full access to this bucket only
      const policyJson = JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:*"],
            Resource: [
              `arn:aws:s3:::${bucketName}`,
              `arn:aws:s3:::${bucketName}/*`,
            ],
          },
        ],
      });

      // -----------------------------------------------------------------------
      // Job: create bucket, IAM user, policy, and attach policy to user
      // -----------------------------------------------------------------------
      const jobName = `minio-init-bucket-${bucketName}`;
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
                        // 1. Configure mc alias with root credentials
                        "mc alias set nimbus $MINIO_ENDPOINT $MINIO_ROOT_USER $MINIO_ROOT_PASSWORD",
                        // 2. Create bucket
                        `mc mb --ignore-existing nimbus/${bucketName}`,
                        // 3. Set public access if requested
                        bucketConfig?.public
                          ? `mc anonymous set download nimbus/${bucketName}`
                          : "",
                        // 4. Create IAM policy scoped to this bucket
                        `echo '${policyJson}' | mc admin policy create nimbus ${bucketName}-policy /dev/stdin`,
                        // 5. Create per-bucket user with generated credentials
                        `mc admin user add nimbus "$BUCKET_ACCESS_KEY" "$BUCKET_SECRET_KEY"`,
                        // 6. Attach the bucket policy to the user
                        `mc admin policy attach nimbus ${bucketName}-policy --user "$BUCKET_ACCESS_KEY"`,
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
                      {
                        name: "BUCKET_ACCESS_KEY",
                        valueFrom: {
                          secretKeyRef: { name: credentialSecretName, key: "accessKey" },
                        },
                      },
                      {
                        name: "BUCKET_SECRET_KEY",
                        valueFrom: {
                          secretKeyRef: { name: credentialSecretName, key: "secretKey" },
                        },
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
        { provider, dependsOn: [helmRelease, credentialSecret] }
      );

      // -----------------------------------------------------------------------
      // Read credentials back from the source secret (ignoreChanges ensures
      // the source secret is stable; reading from it keeps replicas in sync).
      // -----------------------------------------------------------------------
      const storedCreds = k8s.core.v1.Secret.get(
        `minio-${bucketName}-creds-read`,
        pulumi.interpolate`${namespace}/${credentialSecretName}`,
        { provider, dependsOn: [credentialSecret] }
      );
      const stableAccessKey = storedCreds.data.apply((d) =>
        Buffer.from(d?.["accessKey"] ?? "", "base64").toString()
      );
      const stableSecretKey = storedCreds.data.apply((d) =>
        Buffer.from(d?.["secretKey"] ?? "", "base64").toString()
      );

      // Replicate per-bucket credentials to target namespaces
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
              accessKeyId: stableAccessKey,
              secretAccessKey: stableSecretKey,
            },
          },
          { provider, dependsOn: [bucketJob, targetNsResource] }
        );

        secrets[targetNs] = pulumi.output(secretName);
      }

      return {
        name: bucketName,
        endpoint,
        bucketName: pulumi.output(bucketName),
        credentials: { accessKeyId: stableAccessKey, secretAccessKey: stableSecretKey },
        secrets,
        nativeResource: bucketJob,
      };
    },
  };
}

/**
 * Create a Traefik Ingress for MinIO S3 API external access.
 *
 * @example
 * ```typescript
 * createMinioIngress(minio, {
 *   domain: "reyem.ca",
 *   subdomain: "s3",
 * }, provider);
 * // → https://s3.reyem.ca routes to MinIO S3 API
 * ```
 */
export function createMinioIngress(
  minio: IMinIOOperator,
  ingressConfig: IMinIOIngressConfig,
  provider: k8s.Provider
): k8s.networking.v1.Ingress {
  const subdomain = ingressConfig.subdomain ?? "s3";
  const host = `${subdomain}.${ingressConfig.domain}`;
  const certName = ingressConfig.domain.replace(/\./g, "-");
  const tlsSecretName = ingressConfig.tlsSecretName ?? `${certName}-wildcard-tls`;

  // Derive the service name from the Helm release
  const serviceName = minio.helmRelease.status.apply((s) => s?.name ?? "minio-operator");

  return new k8s.networking.v1.Ingress(
    "minio-s3-ingress",
    {
      metadata: {
        name: "minio-s3",
        namespace: DATA_NAMESPACE,
        labels: { "app.kubernetes.io/managed-by": "nimbus" },
        annotations: {
          "traefik.ingress.kubernetes.io/router.entrypoints": "websecure",
        },
      },
      spec: {
        ingressClassName: "traefik",
        tls: [{ secretName: tlsSecretName, hosts: [host] }],
        rules: [
          {
            host,
            http: {
              paths: [
                {
                  path: "/",
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: serviceName,
                      port: { number: MINIO_SERVICE_PORT },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    },
    { provider, dependsOn: [minio.helmRelease] }
  );
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
