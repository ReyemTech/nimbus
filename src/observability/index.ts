/**
 * Observability module — cohesive monitoring and logging stack.
 *
 * @module observability
 */

export type {
  IPrometheusConfig,
  IGrafanaConfig,
  ILokiConfig,
  IAlloyConfig,
  IAlertmanagerConfig,
  IAlertConfig,
  IAlertEmailConfig,
  IAlertSlackConfig,
  IUptimeKumaConfig,
  IObservabilityStackConfig,
  IObservabilityStack,
} from "./interfaces";

export { createObservabilityStack } from "./stack";

export type { IPrometheusRuleGroup, IPrometheusAlertRule } from "./alerts";
export { createPrometheusRule, parseDurationToSeconds } from "./alerts";
