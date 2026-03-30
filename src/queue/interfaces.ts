/**
 * Message queue interfaces for @reyemtech/nimbus.
 *
 * Abstracts managed queues (SQS, Service Bus, Pub/Sub) and
 * operator-based queues (NATS, RabbitMQ, Kafka).
 *
 * @module queue/interfaces
 */

import type * as pulumi from "@pulumi/pulumi";
import type { CloudArg, ResolvedCloudTarget } from "../types";

/** Supported queue engines. */
export type QueueEngine =
  | "sqs" // AWS SQS
  | "service-bus" // Azure Service Bus
  | "pub-sub" // GCP Pub/Sub
  | "nats" // NATS (in-cluster)
  | "rabbitmq" // RabbitMQ (in-cluster)
  | "kafka"; // Kafka/Strimzi (in-cluster)

/** Queue deployment mode. */
export type QueueMode = "managed" | "operator";

/** Queue type (delivery semantics). */
export type QueueType =
  | "standard" // At-least-once, unordered
  | "fifo" // Exactly-once, ordered
  | "streaming"; // Log-based (Kafka, NATS JetStream)

/** Typed constant map for QueueEngine string literals. */
export const QUEUE_ENGINES = {
  SQS: "sqs" as const,
  SERVICE_BUS: "service-bus" as const,
  PUB_SUB: "pub-sub" as const,
  NATS: "nats" as const,
  RABBITMQ: "rabbitmq" as const,
  KAFKA: "kafka" as const,
} satisfies Record<string, QueueEngine>;

/** Typed constant map for QueueMode string literals. */
export const QUEUE_MODES = {
  MANAGED: "managed" as const,
  OPERATOR: "operator" as const,
} satisfies Record<string, QueueMode>;

/** Typed constant map for QueueType string literals. */
export const QUEUE_TYPES = {
  STANDARD: "standard" as const,
  FIFO: "fifo" as const,
  STREAMING: "streaming" as const,
} satisfies Record<string, QueueType>;

/**
 * Queue configuration input.
 *
 * @example
 * ```typescript
 * const config: IQueueConfig = {
 *   cloud: "aws",
 *   engine: "sqs",
 *   queueType: "fifo",
 * };
 * ```
 */
export interface IQueueConfig {
  /** Cloud provider target or multi-cloud array. */
  readonly cloud: CloudArg;
  /** Auto-selected based on cloud if omitted. */
  readonly engine?: QueueEngine;
  /** Deployment mode: managed cloud service or in-cluster operator. */
  readonly mode?: QueueMode;
  /** Queue delivery semantics: standard, FIFO, or streaming. */
  readonly queueType?: QueueType;
  /** Resource tags applied to the queue and child resources. */
  readonly tags?: Readonly<Record<string, string>>;
}

/** Queue output — the created queue resource. */
export interface IQueue {
  /** Logical name of the queue resource. */
  readonly name: string;
  /** Resolved cloud target this queue was provisioned on. */
  readonly cloud: ResolvedCloudTarget;
  /** Queue engine in use. */
  readonly engine: QueueEngine;
  /** Queue endpoint URL or ARN for producing/consuming messages. */
  readonly endpoint: pulumi.Output<string>;

  /** Escape hatch: cloud-native or operator queue resource. */
  readonly nativeResource: pulumi.Resource;
}
