/**
 * Grafana dashboards and ServiceMonitors/PodMonitors for Nimbus observability.
 *
 * All dashboards are provisioned under a "Nimbus" Grafana folder via sidecar
 * annotations. ServiceMonitors and PodMonitors enable Prometheus scraping of
 * component metrics.
 *
 * @module observability/dashboards
 */

import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import { createDashboardConfigMap } from "./_helpers";
import { traefikDashboard } from "./traefik";
import { certManagerDashboard } from "./cert-manager";
import { redisDashboard } from "./redis";
import { cnpgDashboard } from "./cnpg";
import { mariadbDashboard } from "./mariadb";
import { neo4jDashboard } from "./neo4j";
import { minioDashboard } from "./minio";
import { argocdDashboard } from "./argocd";
import { alertsDashboard } from "./alerts";
export { lokiLogsDashboard } from "./loki";
export { createCnpgClusterDashboard } from "./cnpg-cluster";
export { createMariadbClusterDashboard } from "./mariadb-cluster";
export { createNeo4jClusterDashboard } from "./neo4j-cluster";

interface DashboardsConfig {
  namespace: string;
  provider: k8s.Provider;
  dependsOn: pulumi.Resource[];
}

/**
 * Create all Nimbus ServiceMonitors, PodMonitors, and Grafana dashboard ConfigMaps.
 *
 * @param name - Stack name prefix
 * @param config - Namespace, provider, and dependency info
 */
export function createDashboards(name: string, config: DashboardsConfig): void {
  const { namespace, provider, dependsOn } = config;

  // --- ServiceMonitors ---

  // Cert-manager (metrics on port 9402 in cert-manager namespace)
  new k8s.apiextensions.CustomResource(
    `${name}-sm-cert-manager`,
    {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "ServiceMonitor",
      metadata: { name: "cert-manager", namespace, labels: { release: name } },
      spec: {
        namespaceSelector: { matchNames: ["cert-manager"] },
        selector: { matchLabels: { "app.kubernetes.io/name": "cert-manager" } },
        endpoints: [{ port: "tcp-prometheus-servicemonitor", interval: "30s" }],
      },
    },
    { provider, dependsOn }
  );

  // Redis exporter (metrics on port 9121 in data namespace)
  new k8s.apiextensions.CustomResource(
    `${name}-sm-redis`,
    {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "ServiceMonitor",
      metadata: { name: "redis-metrics", namespace, labels: { release: name } },
      spec: {
        namespaceSelector: { matchNames: ["data"] },
        selector: { matchLabels: { "app.kubernetes.io/name": "redis" } },
        endpoints: [{ port: "http-metrics", interval: "30s" }],
      },
    },
    { provider, dependsOn }
  );

  // CNPG PostgreSQL (PodMonitor — pods expose metrics directly on port 9187)
  new k8s.apiextensions.CustomResource(
    `${name}-pm-cnpg`,
    {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "PodMonitor",
      metadata: { name: "cnpg-clusters", namespace, labels: { release: name } },
      spec: {
        namespaceSelector: { matchNames: ["data"] },
        selector: { matchExpressions: [{ key: "cnpg.io/cluster", operator: "Exists" }] },
        podMetricsEndpoints: [{ port: "metrics" }],
      },
    },
    { provider, dependsOn }
  );

  // Traefik (metrics on port 9100 in traefik namespace)
  new k8s.apiextensions.CustomResource(
    `${name}-sm-traefik`,
    {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "ServiceMonitor",
      metadata: { name: "traefik", namespace, labels: { release: name } },
      spec: {
        namespaceSelector: { matchNames: ["traefik"] },
        selector: { matchLabels: { "app.kubernetes.io/name": "traefik" } },
        endpoints: [{ port: "metrics", interval: "15s" }],
      },
    },
    { provider, dependsOn }
  );

  // ArgoCD (metrics created by ArgoCD Helm chart's serviceMonitor.enabled)
  // ServiceMonitors are auto-created by the ArgoCD Helm chart — no need to create here.
  // We only provision the dashboard.

  // MariaDB (metrics exporter sidecar on port 9104 in data namespace)
  new k8s.apiextensions.CustomResource(
    `${name}-pm-mariadb`,
    {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "PodMonitor",
      metadata: { name: "mariadb-metrics", namespace, labels: { release: name } },
      spec: {
        namespaceSelector: { matchNames: ["data"] },
        selector: { matchLabels: { "app.kubernetes.io/name": "mariadb" } },
        podMetricsEndpoints: [{ port: "metrics", interval: "30s" }],
      },
    },
    { provider, dependsOn }
  );

  // MinIO Tenant (metrics on :9000/minio/v2/metrics/cluster in data namespace)
  new k8s.apiextensions.CustomResource(
    `${name}-pm-minio`,
    {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "PodMonitor",
      metadata: { name: "minio-metrics", namespace, labels: { release: name } },
      spec: {
        namespaceSelector: { matchNames: ["data"] },
        selector: { matchLabels: { "v1.min.io/tenant": "minio" } },
        podMetricsEndpoints: [
          { port: "minio-port", path: "/minio/v2/metrics/cluster", interval: "30s" },
          { port: "minio-port", path: "/minio/v2/metrics/node", interval: "30s" },
          { port: "minio-port", path: "/minio/v2/metrics/bucket", interval: "60s" },
        ],
      },
    },
    { provider, dependsOn }
  );

  // Neo4j (metrics on :2004/metrics in data namespace — Enterprise only, pre-configured for upgrade)
  new k8s.apiextensions.CustomResource(
    `${name}-pm-neo4j`,
    {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "PodMonitor",
      metadata: { name: "neo4j-metrics", namespace, labels: { release: name } },
      spec: {
        namespaceSelector: { matchNames: ["data"] },
        selector: { matchLabels: { "helm.neo4j.com/pod_category": "neo4j-instance" } },
        podMetricsEndpoints: [
          // Port 2004 (tcp-prometheus) — Enterprise only. Preconfigured for upgrade.
          { port: "tcp-prometheus", path: "/metrics", interval: "30s" },
        ],
      },
    },
    { provider, dependsOn }
  );

  // --- Dashboard ConfigMaps ---

  createDashboardConfigMap(
    name,
    "cert-manager",
    certManagerDashboard(),
    namespace,
    provider,
    dependsOn
  );
  createDashboardConfigMap(name, "redis", redisDashboard(), namespace, provider, dependsOn);
  createDashboardConfigMap(name, "cnpg", cnpgDashboard(), namespace, provider, dependsOn);
  createDashboardConfigMap(
    name,
    "traefik-ingress",
    traefikDashboard(),
    namespace,
    provider,
    dependsOn
  );
  createDashboardConfigMap(name, "argocd", argocdDashboard(), namespace, provider, dependsOn);
  createDashboardConfigMap(name, "mariadb", mariadbDashboard(), namespace, provider, dependsOn);
  createDashboardConfigMap(name, "neo4j", neo4jDashboard(), namespace, provider, dependsOn);
  createDashboardConfigMap(name, "minio", minioDashboard(), namespace, provider, dependsOn);
  createDashboardConfigMap(name, "alerts", alertsDashboard(), namespace, provider, dependsOn);
}
