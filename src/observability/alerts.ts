/**
 * Alerting module — PrometheusRule CRD helpers, Alertmanager config builder,
 * and global alert rules for cross-cutting concerns (PVC, certs).
 *
 * Per-instance alerts (CNPG, MariaDB, Neo4j, MinIO, Redis, Traefik) are
 * created by their respective module factories, not here.
 *
 * @module observability/alerts
 */

import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import type { IAlertConfig } from "./interfaces";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single Prometheus alert rule. */
export interface IPrometheusAlertRule {
  readonly alert: string;
  readonly expr: string;
  readonly for: string;
  readonly labels: Record<string, string>;
  readonly annotations: Record<string, string>;
}

/** A group of Prometheus alert rules. */
export interface IPrometheusRuleGroup {
  readonly name: string;
  readonly interval?: string;
  readonly rules: IPrometheusAlertRule[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a human-readable duration to seconds for PromQL expressions.
 * Supports: "30s", "5m", "2h", "14d".
 */
export function parseDurationToSeconds(duration: string): number {
  const match = duration.match(/^(\d+)(s|m|h|d)$/);
  if (!match || !match[1] || !match[2]) throw new Error(`Invalid duration: ${duration}`);
  const value = parseInt(match[1], 10);
  switch (match[2]) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 3600;
    case "d":
      return value * 86400;
    default:
      throw new Error(`Unknown unit: ${match[2]}`);
  }
}

/**
 * Create a PrometheusRule CRD with the given alert groups.
 *
 * Used by both global rules (this module) and per-instance rules
 * (operator modules, cache, platform).
 */
export function createPrometheusRule(
  name: string,
  namespace: string,
  groups: IPrometheusRuleGroup[],
  provider: k8s.Provider,
  dependsOn: pulumi.Resource[]
): void {
  if (groups.length === 0) return;

  new k8s.apiextensions.CustomResource(
    `${name}-prometheus-rule`,
    {
      apiVersion: "monitoring.coreos.com/v1",
      kind: "PrometheusRule",
      metadata: {
        name,
        namespace,
        labels: {
          "app.kubernetes.io/managed-by": "nimbus",
          "prometheus.io/rule": "true",
        },
      },
      spec: { groups },
    },
    { provider, dependsOn }
  );
}

// ---------------------------------------------------------------------------
// Global alert rules (PVC + cert-manager)
// ---------------------------------------------------------------------------

/**
 * Create global PrometheusRule for cross-cutting alerts.
 * Called from createObservabilityStack() when alerts are configured.
 */
export function createGlobalAlertRules(
  name: string,
  namespace: string,
  provider: k8s.Provider,
  dependsOn: pulumi.Resource[]
): void {
  createPrometheusRule(
    `${name}-global-alerts`,
    namespace,
    [
      // PVC disk usage (all namespaces)
      {
        name: "nimbus.pvc",
        interval: "60s",
        rules: [
          {
            alert: "PvcDiskUsageCritical",
            expr: `(kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes) > 0.9`,
            for: "5m",
            labels: { severity: "critical" },
            annotations: {
              summary:
                "PVC {{ $labels.persistentvolumeclaim }} in {{ $labels.namespace }} is {{ $value | humanizePercentage }} full",
              description: "PVC disk usage exceeds 90%. Pod may crash if storage fills completely.",
            },
          },
          {
            alert: "PvcDiskUsageWarning",
            expr: `(kubelet_volume_stats_used_bytes / kubelet_volume_stats_capacity_bytes) > 0.75`,
            for: "10m",
            labels: { severity: "warning" },
            annotations: {
              summary:
                "PVC {{ $labels.persistentvolumeclaim }} in {{ $labels.namespace }} is {{ $value | humanizePercentage }} full",
              description: "PVC disk usage exceeds 75%. Plan capacity expansion.",
            },
          },
        ],
      },
      // Certificate expiry (cert-manager)
      {
        name: "nimbus.certmanager",
        rules: [
          {
            alert: "CertificateExpiryCritical",
            expr: `(certmanager_certificate_expiration_timestamp_seconds - time()) < ${parseDurationToSeconds("7d")}`,
            for: "1h",
            labels: { severity: "critical" },
            annotations: {
              summary:
                "Certificate {{ $labels.name }} in {{ $labels.namespace }} expires in less than 7 days",
              description: "cert-manager should auto-renew. This alert means renewal failed.",
            },
          },
        ],
      },
    ],
    provider,
    dependsOn
  );
}

// ---------------------------------------------------------------------------
// Alertmanager config builder
// ---------------------------------------------------------------------------

/**
 * Build Alertmanager Helm values for receivers and routes.
 *
 * Returns values to deep-merge into the kube-prometheus-stack
 * alertmanager section.
 */
export function buildAlertmanagerConfig(alertConfig: IAlertConfig): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const receivers: any[] = [{ name: "null" }];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const routes: any[] = [];
  const secretNames: string[] = [];

  // Email receivers
  if (alertConfig.email) {
    const transport = alertConfig.email.transport;
    const to = Array.isArray(alertConfig.email.to)
      ? alertConfig.email.to.join(", ")
      : alertConfig.email.to;

    if (transport.secretName) {
      secretNames.push(transport.secretName);
    }

    const emailConfig = {
      to,
      from: transport.fromAddress,
      smarthost: `${transport.host}:${transport.port}`,
      auth_username: transport.username,
      auth_password_file: transport.secretName
        ? `/etc/alertmanager/secrets/${transport.secretName}/password`
        : undefined,
      require_tls: true,
      send_resolved: true,
    };

    receivers.push({ name: "email-critical", email_configs: [emailConfig] });
    receivers.push({ name: "email-warning", email_configs: [emailConfig] });

    routes.push({
      receiver: "email-critical",
      matchers: ['severity="critical"'],
      group_wait: "10s",
      group_interval: "1m",
      repeat_interval: "1h",
      continue: !!alertConfig.slack,
    });
    routes.push({
      receiver: "email-warning",
      matchers: ['severity="warning"'],
      group_wait: "5m",
      group_interval: "10m",
      repeat_interval: "12h",
      continue: !!alertConfig.slack,
    });
  }

  // Slack receivers
  if (alertConfig.slack) {
    const webhookSecretName = alertConfig.slack.webhookUrlSecret;
    secretNames.push(webhookSecretName);

    const slackBase = {
      api_url_file: `/etc/alertmanager/secrets/${webhookSecretName}/webhook-url`,
      channel: alertConfig.slack.channel,
      username: alertConfig.slack.username ?? "Nimbus Alerts",
      send_resolved: true,
      icon_emoji: ":warning:",
    };

    receivers.push({
      name: "slack-critical",
      slack_configs: [
        {
          ...slackBase,
          color: "danger",
          title: `[CRITICAL] {{ .GroupLabels.alertname }}`,
          text: `{{ range .Alerts }}{{ .Annotations.summary }}\n{{ end }}`,
        },
      ],
    });
    receivers.push({
      name: "slack-warning",
      slack_configs: [
        {
          ...slackBase,
          color: "warning",
          title: `[WARNING] {{ .GroupLabels.alertname }}`,
          text: `{{ range .Alerts }}{{ .Annotations.summary }}\n{{ end }}`,
        },
      ],
    });

    routes.push({
      receiver: "slack-critical",
      matchers: ['severity="critical"'],
      group_wait: "10s",
      group_interval: "1m",
      repeat_interval: "1h",
    });
    routes.push({
      receiver: "slack-warning",
      matchers: ['severity="warning"'],
      group_wait: "5m",
      group_interval: "10m",
      repeat_interval: "12h",
    });
  }

  // Silenced routes — matched first, sent to null receiver.
  // These are alerts that fire on managed K8s but aren't actionable.
  const silencedRoutes = [
    {
      receiver: "null",
      matchers: ['alertname=~"KubeControllerManagerDown|KubeSchedulerDown|KubeProxyDown"'],
      continue: false,
    },
  ];

  return {
    config: {
      global: { resolve_timeout: "5m" },
      route: {
        receiver: "null",
        group_by: ["alertname", "namespace"],
        group_wait: "30s",
        group_interval: "5m",
        repeat_interval: "4h",
        routes: [...silencedRoutes, ...routes],
      },
      receivers,
    },
    alertmanagerSpec: {
      secrets: secretNames,
    },
  };
}
