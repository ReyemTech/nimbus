/**
 * Shared type for services that can be exposed via access gateway (Tailscale).
 *
 * @module types/exposed-service
 */

import type * as pulumi from "@pulumi/pulumi";

/** A Kubernetes service that can be exposed to the access gateway. */
export interface IExposedService {
  /** K8s service name (may be an Output when derived from Helm release names). */
  readonly name: string | pulumi.Output<string>;
  /** K8s namespace. */
  readonly namespace: string;
  /** Primary port number. */
  readonly port: number;
  /** Human-readable label (e.g., "grafana", "vault"). */
  readonly label: string;
}
