/**
 * MinIO backend — deploys MinIO via the MinIO Operator (operator.min.io)
 * using the Tenant CRD pattern. The operator is installed via Helm by
 * index.ts; this module creates Tenant CRDs and provisions buckets with
 * per-bucket IAM users via Kubernetes Jobs using the MinIO Client (mc).
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
import { createPrometheusRule } from "../observability/alerts";

const DATA_NAMESPACE = "data";
const DEFAULT_STORAGE_GB = 20;
const MINIO_SERVICE_PORT = 80;
const TENANT_NAME = "minio";

/**
 * Create a MinIO Tenant via the MinIO Operator and return an IMinIOOperator
 * with a createBucket() method for provisioning object storage buckets.
 *
 * The operator Helm release is installed by index.ts. This function creates:
 * 1. A root credentials Secret (config.env format)
 * 2. A Tenant CRD in the data namespace
 * 3. Returns an operator with createBucket() for per-bucket provisioning
 *
 * @example
 * ```typescript
 * const minio = createOperator("minio", { cluster });
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
  const namespace = ensureNamespace(DATA_NAMESPACE, provider);
  const storageGb = DEFAULT_STORAGE_GB;
  const storageClass = resolveStorageTier("standard", config.cluster.storageTiers);

  // Generate root credentials
  const rootUser = "minio-admin";
  const rootPassword = pulumi.secret(crypto.randomBytes(24).toString("base64url"));

  // Root credentials Secret in config.env format (required by MinIO Operator Tenant CRD)
  const configSecretName = `${TENANT_NAME}-env-config`;
  const configSecret = new k8s.core.v1.Secret(
    `${TENANT_NAME}-config`,
    {
      metadata: {
        name: configSecretName,
        namespace: DATA_NAMESPACE,
        labels: { "app.kubernetes.io/managed-by": "nimbus" },
      },
      stringData: {
        "config.env": pulumi.interpolate`export MINIO_ROOT_USER="${rootUser}"\nexport MINIO_ROOT_PASSWORD="${rootPassword}"\nexport MINIO_PROMETHEUS_AUTH_TYPE="public"`,
      },
    },
    { provider, dependsOn: [namespace, helmRelease], ignoreChanges: ["data", "stringData"] }
  );

  // Separate root credentials secret with individual keys (for Jobs to reference)
  const rootSecretName = `${TENANT_NAME}-root-credentials`;
  const rootSecret = new k8s.core.v1.Secret(
    `${TENANT_NAME}-root-creds`,
    {
      metadata: {
        name: rootSecretName,
        namespace: DATA_NAMESPACE,
        labels: { "app.kubernetes.io/managed-by": "nimbus" },
      },
      stringData: {
        rootUser,
        rootPassword,
      },
    },
    { provider, dependsOn: [namespace, helmRelease], ignoreChanges: ["data", "stringData"] }
  );

  // Tenant CRD — creates a single-pool MinIO deployment
  const tenant = new k8s.apiextensions.CustomResource(
    `${TENANT_NAME}-tenant`,
    {
      apiVersion: "minio.min.io/v2",
      kind: "Tenant",
      metadata: {
        name: TENANT_NAME,
        namespace: DATA_NAMESPACE,
        labels: { "app.kubernetes.io/managed-by": "nimbus" },
      },
      spec: {
        image: "quay.io/minio/minio:latest",
        imagePullPolicy: "IfNotPresent",
        configuration: { name: configSecretName },
        requestAutoCert: false,
        pools: [
          {
            name: "pool-0",
            servers: 1,
            volumesPerServer: 1,
            volumeClaimTemplate: {
              metadata: { name: "data" },
              spec: {
                accessModes: ["ReadWriteOnce"],
                ...(storageClass ? { storageClassName: storageClass } : {}),
                resources: { requests: { storage: `${storageGb}Gi` } },
              },
            },
            resources: {
              requests: { cpu: "100m", memory: "256Mi" },
            },
            containerSecurityContext: {
              runAsUser: 1000,
              runAsGroup: 1000,
              runAsNonRoot: true,
            },
          },
        ],
        mountPath: "/export",
        // Allow Prometheus to scrape metrics without auth
        env: [{ name: "MINIO_PROMETHEUS_AUTH_TYPE", value: "public" }],
      },
    },
    { provider, dependsOn: [helmRelease, configSecret] }
  );

  // MinIO alert rules
  createPrometheusRule(
    `${TENANT_NAME}-minio-alerts`,
    "observability",
    [
      {
        name: "nimbus.minio",
        rules: [
          {
            alert: "MinioClusterUnhealthy",
            expr: `minio_cluster_health_status != 1`,
            for: "5m",
            labels: { severity: "critical" },
            annotations: { summary: "MinIO cluster is unhealthy" },
          },
        ],
      },
    ],
    provider,
    [tenant]
  );

  // MinIO Operator creates a service named "minio" in the tenant namespace
  // S3 API at minio.data.svc.cluster.local:80 (HTTP when requestAutoCert: false)
  const endpoint = pulumi.output(
    `http://${TENANT_NAME}.${DATA_NAMESPACE}.svc.cluster.local:${MINIO_SERVICE_PORT}`
  );

  return {
    name: "minio",
    type: "minio",
    helmRelease,
    endpoint,
    exposedServices: [
      { name: "minio-console", namespace: DATA_NAMESPACE, port: 9090, label: "minio" },
    ],

    createBucket(bucketName: string, bucketConfig?: IMinIOBucketConfig): IMinIOBucket {
      const targetNamespaces = bucketConfig?.namespaces ?? [];

      // Generate per-bucket credentials
      const bucketAccessKey = pulumi.secret(
        `nimbus-${bucketName}-${crypto.randomBytes(6).toString("hex")}`
      );
      const bucketSecretKey = pulumi.secret(crypto.randomBytes(30).toString("base64url"));

      // Store per-bucket credentials (the Job reads these to create the MinIO user)
      const credentialSecretName = `minio-${bucketName}-credentials`;
      const credentialSecret = new k8s.core.v1.Secret(
        `minio-${bucketName}-creds`,
        {
          metadata: {
            name: credentialSecretName,
            namespace: DATA_NAMESPACE,
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
          dependsOn: [tenant],
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
            Resource: [`arn:aws:s3:::${bucketName}`, `arn:aws:s3:::${bucketName}/*`],
          },
        ],
      });

      // Job: create bucket, IAM user, policy, and attach policy to user
      const jobName = `minio-init-bucket-${bucketName}`;
      const bucketJob = new k8s.batch.v1.Job(
        jobName,
        {
          metadata: {
            name: jobName,
            namespace: DATA_NAMESPACE,
            labels: {
              "app.kubernetes.io/managed-by": "nimbus",
              "nimbus/bucket": bucketName,
            },
          },
          spec: {
            ttlSecondsAfterFinished: 300,
            backoffLimit: 5,
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
                        `echo '${policyJson}' | mc admin policy create nimbus ${bucketName}-policy /dev/stdin`,
                        `mc admin user add nimbus "$BUCKET_ACCESS_KEY" "$BUCKET_SECRET_KEY"`,
                        `mc admin policy attach nimbus ${bucketName}-policy --user "$BUCKET_ACCESS_KEY"`,
                      ]
                        .filter(Boolean)
                        .join(" && "),
                    ],
                    env: [
                      { name: "MINIO_ENDPOINT", value: endpoint },
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
        { provider, dependsOn: [tenant, rootSecret, credentialSecret] }
      );

      // Read credentials back from stored secret for stability
      const storedCreds = k8s.core.v1.Secret.get(
        `minio-${bucketName}-creds-read`,
        pulumi.interpolate`${DATA_NAMESPACE}/${credentialSecretName}`,
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
 * With the operator/tenant pattern, the service is always named "minio"
 * in the data namespace on port 80 (HTTP) or 443 (HTTPS).
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
                      name: TENANT_NAME,
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
