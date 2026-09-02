/**
 * Prometheus exporter that classifies Trivy VulnerabilityReport findings by exposure.
 *
 * @module platform/components/trivy-exposure-classifier
 */

import * as k8s from "@pulumi/kubernetes";
import type { ITrivyExposureClassifierConfig } from "../interfaces";

const DEFAULT_NAMESPACE = "observability";
const DEFAULT_IMAGE = "node:22-alpine";
const DEFAULT_INTERVAL_SECONDS = 60;

// Keep this dependency-free: the pod uses its service-account token and CA directly
// instead of needing a Kubernetes client library or credentials beyond read-only RBAC.
const CLASSIFIER_SCRIPT = String.raw`"use strict";
const fs = require("node:fs");
const https = require("node:https");
const token = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/token", "utf8").trim();
const ca = fs.readFileSync("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt");
const host = process.env.KUBERNETES_SERVICE_HOST;
const port = process.env.KUBERNETES_SERVICE_PORT_HTTPS || "443";
const interval = Number(process.env.INTERVAL_SECONDS || "60") * 1000;
let metrics = "# HELP nimbus_trivy_vulnerability_findings Trivy VulnerabilityReport findings classified by network exposure.\n# TYPE nimbus_trivy_vulnerability_findings gauge\n";

function get(path) {
  return new Promise((resolve, reject) => {
    const request = https.request({ host, port, path, method: "GET", ca, headers: { Authorization: "Bearer " + token } }, response => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => {
        if (response.statusCode !== 200) return reject(new Error("GET " + path + " returned " + response.statusCode));
        try { resolve(JSON.parse(body)); } catch (error) { reject(error); }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function labelsMatch(selector, labels) {
  return selector && Object.keys(selector).length > 0 && labels && Object.entries(selector).every(([key, value]) => labels[key] === value);
}

function ingressServices(ingress) {
  const names = [];
  const backend = ingress.spec && ingress.spec.defaultBackend;
  if (backend && backend.service && backend.service.name) names.push(backend.service.name);
  for (const rule of (ingress.spec && ingress.spec.rules) || []) {
    for (const path of (rule.http && rule.http.paths) || []) {
      if (path.backend && path.backend.service && path.backend.service.name) names.push(path.backend.service.name);
    }
  }
  return new Set(names);
}

function workloadFor(report, workloads) {
  const labels = report.metadata.labels || {};
  const namespace = labels["trivy-operator.resource.namespace"] || report.metadata.namespace;
  const name = labels["trivy-operator.resource.name"] || ((report.metadata.ownerReferences || [])[0] || {}).name;
  const kind = labels["trivy-operator.resource.kind"] || ((report.metadata.ownerReferences || [])[0] || {}).kind;
  const normalizedKind = String(kind || "").toLowerCase();
  const resource = workloads.find(item => item.metadata.namespace === namespace && item.metadata.name === name && item.kind.toLowerCase() === normalizedKind);
  return resource || null;
}

function podLabels(workload) {
  const spec = workload.spec || {};
  const template = spec.template || (spec.jobTemplate && spec.jobTemplate.spec && spec.jobTemplate.spec.template);
  return template && template.metadata && template.metadata.labels;
}

function escape(value) {
  return String(value || "unknown").replace(/\\/g, "\\\\").replace(/\"/g, "\\\"").replace(/\n/g, "\\n");
}

async function refresh() {
  try {
    const [reports, deployments, statefulsets, daemonsets, jobs, cronjobs, services, ingresses] = await Promise.all([
      get("/apis/aquasecurity.github.io/v1alpha1/vulnerabilityreports"),
      get("/apis/apps/v1/deployments"), get("/apis/apps/v1/statefulsets"), get("/apis/apps/v1/daemonsets"),
      get("/apis/batch/v1/jobs"), get("/apis/batch/v1/cronjobs"), get("/api/v1/services"), get("/apis/networking.k8s.io/v1/ingresses"),
    ]);
    const workloads = [].concat(deployments.items || [], statefulsets.items || [], daemonsets.items || [], jobs.items || [], cronjobs.items || []);
    const ingressByNamespace = new Map();
    for (const ingress of ingresses.items || []) {
      const namespace = ingress.metadata.namespace;
      const names = ingressByNamespace.get(namespace) || new Set();
      for (const name of ingressServices(ingress)) names.add(name);
      ingressByNamespace.set(namespace, names);
    }
    const totals = new Map();
    for (const report of reports.items || []) {
      const workload = workloadFor(report, workloads);
      const artifact = report.report && report.report.artifact || {};
      const image = artifact.repository ? artifact.repository + (artifact.tag ? ":" + artifact.tag : artifact.digest ? "@" + artifact.digest : "") : "unknown";
      let exposure = "unknown";
      let resource = "unknown";
      let kind = "unknown";
      const namespace = report.metadata.namespace || "unknown";
      if (workload) {
        resource = workload.metadata.name;
        kind = workload.kind;
        const labels = podLabels(workload);
        const matches = (services.items || []).filter(service => service.metadata.namespace === namespace && labelsMatch(service.spec && service.spec.selector, labels));
        if (matches.length) {
          exposure = matches.some(service => service.spec && service.spec.type === "LoadBalancer" || (ingressByNamespace.get(namespace) || new Set()).has(service.metadata.name)) ? "external" : "internal";
        }
      }
      for (const vulnerability of report.report && report.report.vulnerabilities || []) {
        const severity = String(vulnerability.severity || "UNKNOWN").toLowerCase();
        const key = [namespace, resource, kind, image, severity, exposure].join("\u0000");
        totals.set(key, (totals.get(key) || 0) + 1);
      }
    }
    metrics = "# HELP nimbus_trivy_vulnerability_findings Trivy VulnerabilityReport findings classified by network exposure.\n# TYPE nimbus_trivy_vulnerability_findings gauge\n";
    for (const [key, count] of totals) {
      const [namespace, resource, kind, image, severity, exposure] = key.split("\u0000");
      metrics += "nimbus_trivy_vulnerability_findings{namespace=\"" + escape(namespace) + "\",resource=\"" + escape(resource) + "\",resource_kind=\"" + escape(kind) + "\",image=\"" + escape(image) + "\",severity=\"" + escape(severity) + "\",exposure=\"" + escape(exposure) + "\"} " + count + "\n";
    }
  } catch (error) {
    console.error("failed to refresh Trivy exposure metrics:", error.message);
  }
}

require("node:http").createServer((request, response) => {
  if (request.url !== "/metrics") { response.writeHead(404); return response.end(); }
  response.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
  response.end(metrics);
}).listen(8080, "0.0.0.0");
refresh();
setInterval(refresh, interval);`;

/** Deploy the Trivy VulnerabilityReport exposure classifier and Prometheus scrape target. */
export function createTrivyExposureClassifier(
  name: string,
  config: ITrivyExposureClassifierConfig,
  provider: k8s.Provider,
  dependsOn?: k8s.helm.v3.Release
): k8s.apps.v1.Deployment {
  const namespace = config.namespace ?? DEFAULT_NAMESPACE;
  const app = "trivy-exposure-classifier";
  const image = config.image ?? DEFAULT_IMAGE;
  const intervalSeconds = config.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
  const options = { provider, dependsOn: dependsOn ? [dependsOn] : undefined };

  const serviceAccount = new k8s.core.v1.ServiceAccount(
    `${name}-${app}`,
    { metadata: { name: app, namespace } },
    { provider }
  );
  const role = new k8s.rbac.v1.ClusterRole(
    `${name}-${app}`,
    {
      metadata: { name: app },
      rules: [
        {
          apiGroups: ["aquasecurity.github.io"],
          resources: ["vulnerabilityreports"],
          verbs: ["get", "list"],
        },
        {
          apiGroups: ["apps"],
          resources: ["deployments", "statefulsets", "daemonsets"],
          verbs: ["get", "list"],
        },
        { apiGroups: ["batch"], resources: ["jobs", "cronjobs"], verbs: ["get", "list"] },
        { apiGroups: [""], resources: ["services"], verbs: ["get", "list"] },
        { apiGroups: ["networking.k8s.io"], resources: ["ingresses"], verbs: ["get", "list"] },
      ],
    },
    { provider }
  );
  const binding = new k8s.rbac.v1.ClusterRoleBinding(
    `${name}-${app}`,
    {
      metadata: { name: app },
      roleRef: { apiGroup: "rbac.authorization.k8s.io", kind: "ClusterRole", name: app },
      subjects: [{ kind: "ServiceAccount", name: app, namespace }],
    },
    { provider, dependsOn: [role, serviceAccount] }
  );
  const script = new k8s.core.v1.ConfigMap(
    `${name}-${app}-script`,
    {
      metadata: { name: `${app}-script`, namespace },
      data: { "classifier.js": CLASSIFIER_SCRIPT },
    },
    { provider }
  );
  const deployment = new k8s.apps.v1.Deployment(
    `${name}-${app}`,
    {
      metadata: { name: app, namespace, labels: { app } },
      spec: {
        replicas: 1,
        selector: { matchLabels: { app } },
        template: {
          metadata: { labels: { app } },
          spec: {
            serviceAccountName: app,
            automountServiceAccountToken: true,
            securityContext: {
              runAsNonRoot: true,
              runAsUser: 10001,
              runAsGroup: 10001,
              seccompProfile: { type: "RuntimeDefault" },
            },
            containers: [
              {
                name: "classifier",
                image,
                command: ["node", "/app/classifier.js"],
                env: [{ name: "INTERVAL_SECONDS", value: String(intervalSeconds) }],
                ports: [{ name: "metrics", containerPort: 8080 }],
                resources: {
                  requests: { cpu: "25m", memory: "64Mi" },
                  limits: { cpu: "100m", memory: "128Mi" },
                },
                securityContext: {
                  allowPrivilegeEscalation: false,
                  readOnlyRootFilesystem: true,
                  capabilities: { drop: ["ALL"] },
                },
                volumeMounts: [{ name: "script", mountPath: "/app", readOnly: true }],
              },
            ],
            volumes: [{ name: "script", configMap: { name: `${app}-script`, defaultMode: 0o444 } }],
          },
        },
      },
    },
    { ...options, dependsOn: [binding, script, ...(dependsOn ? [dependsOn] : [])] }
  );
  const service = new k8s.core.v1.Service(
    `${name}-${app}`,
    {
      metadata: { name: app, namespace, labels: { app } },
      spec: { selector: { app }, ports: [{ name: "metrics", port: 8080, targetPort: "metrics" }] },
    },
    { provider, dependsOn: [deployment] }
  );
  new k8s.apiextensions.CustomResource(
    `${name}-${app}-monitor`,
    {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "ServiceMonitor",
      metadata: {
        name: app,
        namespace,
        labels: config.serviceMonitorLabels ?? { release: "kube-prometheus-stack" },
      },
      spec: {
        selector: { matchLabels: { app } },
        endpoints: [{ port: "metrics", path: "/metrics", interval: "60s" }],
      },
    },
    { provider, dependsOn: [service] }
  );
  return deployment;
}
