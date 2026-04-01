/**
 * Shared type for services that can be exposed via access gateway (Tailscale).
 *
 * @module types/exposed-service
 */

import type * as pulumi from "@pulumi/pulumi";

/** A Kubernetes service that can be exposed to the access gateway. */
export interface IExposedService {
  /** Clean alias name used for DNS (e.g., "grafana"). */
  readonly name: string | pulumi.Output<string>;
  /** Original Helm-managed service name for Tailscale annotation. */
  readonly originalName?: string | pulumi.Output<string>;
  /** K8s namespace. */
  readonly namespace: string;
  /** Primary port number. */
  readonly port: number;
  /** Human-readable label (e.g., "grafana", "vault"). */
  readonly label: string;
}
