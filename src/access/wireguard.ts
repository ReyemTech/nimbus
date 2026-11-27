/**
 * WireGuard access gateway provider.
 *
 * Deploys a self-hosted WireGuard server pod with LoadBalancer,
 * generates client configs, and optional split DNS.
 *
 * @module access/wireguard
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IWireGuardGatewayConfig, IWireGuardPeer, IAccessGateway } from "./interfaces";
import { deployAccessDns } from "./dns";
import { ensureNamespace } from "../utils/ensure-namespace";
import { resolvePodDisruptionBudget } from "../availability";

const NAMESPACE = "access";
const DEFAULT_PORT = 51820;

/**
 * Build WireGuard client config for a peer.
 */
function buildClientConfig(
  peer: IWireGuardPeer,
  serverPublicKey: pulumi.Output<string>,
  endpoint: string,
  listenPort: number,
  routes: ReadonlyArray<string>,
  serverCidr: string,
  dnsIp?: pulumi.Output<string>
): pulumi.Output<string> {
  return pulumi.all([serverPublicKey, dnsIp ?? pulumi.output("")]).apply(([pubKey, dns]) => {
    const lines = [
      "[Interface]",
      "PrivateKey = <YOUR_PRIVATE_KEY>",
      `Address = ${peer.allowedIps[0]}`,
    ];

    if (dns) {
      lines.push(`DNS = ${dns}`);
    }

    lines.push("");
    lines.push("[Peer]");
    lines.push(`PublicKey = ${pubKey}`);
    lines.push(`Endpoint = ${endpoint}:${listenPort}`);
    lines.push(`AllowedIPs = ${[...routes, serverCidr].join(", ")}`);
    lines.push("PersistentKeepalive = 25");

    return lines.join("\n");
  });
}

/**
 * Deploy WireGuard access gateway.
 */
export function deployWireGuard(name: string, config: IWireGuardGatewayConfig): IAccessGateway {
  const k8sProvider = config.cluster.provider;
  const prefix = config.hostnamePrefix ?? name;
  const listenPort = config.wireguard.listenPort ?? DEFAULT_PORT;
  const nsResource = ensureNamespace(NAMESPACE, k8sProvider);
  if (config.wireguard.scheduling?.spread !== undefined) {
    throw new Error(
      "WireGuard scheduling.spread is not supported because the chart hard-codes topology spread constraints"
    );
  }
  const rawValues = config.wireguard.values ?? {};
  const rawReplicas = rawValues.replicaCount;
  const typedReplicas = config.wireguard.scheduling?.replicas;
  const rawAutoscaling = (rawValues.autoscaling ?? {}) as Record<string, unknown>;
  const daemonSet = rawValues.daemonSet === true;
  const typedBudget = config.wireguard.podDisruptionBudget;
  const rawBudget = rawValues.disruptionBudget;
  if (typedReplicas !== undefined && rawAutoscaling.enabled === true) {
    throw new Error("scheduling.replicas conflicts with Helm values.autoscaling.enabled");
  }
  if (typedReplicas !== undefined && daemonSet) {
    throw new Error("scheduling.replicas is not supported with daemonSet: true");
  }
  if (
    daemonSet &&
    typedBudget !== undefined &&
    typedBudget.enabled !== false &&
    typedBudget.minAvailable === undefined &&
    typedBudget.maxUnavailable === undefined
  ) {
    throw new Error(
      "podDisruptionBudget is not supported with daemonSet unless an explicit bound is provided"
    );
  }
  if (typedBudget !== undefined && rawBudget !== undefined) {
    throw new Error("podDisruptionBudget conflicts with Helm values.disruptionBudget");
  }
  if (typedReplicas !== undefined && rawReplicas !== undefined && typedReplicas !== rawReplicas) {
    throw new Error("scheduling.replicas conflicts with Helm values.replicaCount");
  }
  const actualReplicas =
    rawAutoscaling.enabled !== false && typeof rawAutoscaling.minReplicas === "number"
      ? rawAutoscaling.minReplicas
      : typeof rawReplicas === "number"
        ? rawReplicas
        : 3;
  const replicas = typedReplicas ?? actualReplicas;
  let chartBudget: Record<string, unknown> | undefined;
  if (typedBudget !== undefined) {
    if (typedBudget.enabled === false) {
      chartBudget = { enabled: false };
    } else {
      if (typedBudget.maxUnavailable !== undefined) {
        throw new Error(
          "WireGuard chart disruptionBudget supports minAvailable only; maxUnavailable cannot be represented"
        );
      }
      if (typedBudget.minAvailable !== undefined && typeof typedBudget.minAvailable !== "number") {
        throw new Error(
          "WireGuard chart disruptionBudget.minAvailable supports integer values only"
        );
      }
      const resolved = resolvePodDisruptionBudget(typedBudget, replicas);
      const minAvailable =
        resolved && "minAvailable" in resolved
          ? resolved.minAvailable
          : replicas - Number(resolved?.maxUnavailable ?? 1);
      chartBudget = { enabled: true, minAvailable };
    }
  }

  const helmRelease = new k8s.helm.v3.Release(
    `${name}-wireguard`,
    {
      chart: "wireguard",
      repositoryOpts: { repo: "https://bryopsida.github.io/wireguard-chart" },
      version: config.wireguard.version,
      namespace: NAMESPACE,
      createNamespace: false,
      values: {
        interface: {
          address: config.wireguard.serverCidr,
          listenPort,
          peers: config.wireguard.peers.map((peer) => ({
            publicKey: peer.publicKey,
            allowedIPs: peer.allowedIps.join(", "),
          })),
          routes: config.wireguard.routes,
        },
        service: {
          type: "LoadBalancer",
          port: listenPort,
          annotations: {
            "external-dns.alpha.kubernetes.io/hostname": config.wireguard.endpoint,
          },
        },
        persistence: {
          enabled: true,
          size: "100Mi",
        },
        ...rawValues,
        ...(typedReplicas !== undefined
          ? {
              replicaCount: typedReplicas,
              autoscaling: { ...rawAutoscaling, enabled: false },
            }
          : {}),
        ...(chartBudget !== undefined ? { disruptionBudget: chartBudget } : {}),
      },
    },
    { provider: k8sProvider, dependsOn: [nsResource] }
  );

  // Split DNS
  let dnsClusterIp: pulumi.Output<string> | undefined;
  if (config.dns?.enabled) {
    const dns = deployAccessDns(
      name,
      prefix,
      config.dns,
      NAMESPACE,
      k8sProvider,
      [],
      [nsResource],
      config.dns
    );
    dnsClusterIp = dns.clusterIp;
  }

  // Server public key: must be read from the running pod after first deploy
  const serverPublicKey = pulumi.output(
    "<run 'kubectl exec wireguard-0 -n access -- wg show wg0 public-key' after first deploy>"
  );

  const clientConfigs = pulumi
    .output(
      Object.fromEntries(
        config.wireguard.peers.map((peer) => [
          peer.name,
          buildClientConfig(
            peer,
            serverPublicKey,
            config.wireguard.endpoint,
            listenPort,
            config.wireguard.routes,
            config.wireguard.serverCidr,
            dnsClusterIp
          ),
        ])
      )
    )
    .apply((entries) => {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(entries)) {
        result[key] = value as string;
      }
      return result;
    });

  return {
    name,
    provider: "wireguard",
    namespace: NAMESPACE,
    helmRelease,
    serverPublicKey,
    clientConfigs,
  };
}
