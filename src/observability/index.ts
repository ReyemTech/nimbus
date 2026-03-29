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
  IObservabilityStackConfig,
  IObservabilityStack,
} from "./interfaces";

export { createObservabilityStack } from "./stack";
