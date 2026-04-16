/**
 * Image-cache pruner DaemonSet.
 *
 * Runs `crictl rmi --prune` on each node every N seconds to reclaim
 * disk space from unused container images. Safe by design — crictl
 * never removes images with active references.
 *
 * Image strategy: alpine base + crictl downloaded from kubernetes-sigs/cri-tools
 * GitHub releases at pod start. Cached in container fs after first start.
 * Multi-arch supported via $(uname -m) → amd64/arm64 mapping.
 *
 * @module platform/components/image-pruner
 */

import * as k8s from "@pulumi/kubernetes";
import type { IImagePrunerConfig } from "../interfaces";

const CRICTL_VERSION = "v1.30.0";
const DEFAULT_IMAGE = "alpine:3.20";
const DEFAULT_INTERVAL = 21600; // 6 hours
const DEFAULT_NAMESPACE = "kube-system";

export function createImagePruner(
  name: string,
  config: IImagePrunerConfig,
  provider: k8s.Provider
): k8s.apps.v1.DaemonSet | null {
  if (config.enabled === false) {
    return null;
  }

  const interval = config.intervalSeconds ?? DEFAULT_INTERVAL;
  const image = config.image ?? DEFAULT_IMAGE;
  const namespace = config.namespace ?? DEFAULT_NAMESPACE;

  const script = `set -e
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) ARCH=amd64 ;;
  aarch64) ARCH=arm64 ;;
  *) echo "unsupported arch: $ARCH"; exit 1 ;;
esac
if [ ! -x /usr/local/bin/crictl ]; then
  apk add --no-cache curl tar
  curl -fsSL https://github.com/kubernetes-sigs/cri-tools/releases/download/${CRICTL_VERSION}/crictl-${CRICTL_VERSION}-linux-\${ARCH}.tar.gz \\
    | tar -xz -C /usr/local/bin
fi
while true; do
  echo "[$(date -Iseconds)] pruning unused images..."
  crictl --runtime-endpoint unix:///run/containerd/containerd.sock rmi --prune || echo "prune failed (will retry)"
  sleep ${interval}
done`;

  return new k8s.apps.v1.DaemonSet(
    `${name}-image-pruner`,
    {
      metadata: {
        name: "image-pruner",
        namespace,
        labels: { app: "image-pruner" },
      },
      spec: {
        selector: { matchLabels: { app: "image-pruner" } },
        template: {
          metadata: { labels: { app: "image-pruner" } },
          spec: {
            tolerations: [{ operator: "Exists", effect: "NoSchedule" }],
            hostPID: false,
            containers: [
              {
                name: "pruner",
                image,
                command: ["/bin/sh", "-c"],
                args: [script],
                securityContext: {
                  privileged: true,
                  runAsUser: 0,
                },
                resources: {
                  requests: {
                    cpu: "50m",
                    memory: "50Mi",
                    "ephemeral-storage": "100Mi",
                  },
                  limits: {
                    cpu: "100m",
                    memory: "100Mi",
                    "ephemeral-storage": "200Mi",
                  },
                },
                volumeMounts: [
                  {
                    name: "containerd-sock",
                    mountPath: "/run/containerd/containerd.sock",
                  },
                ],
              },
            ],
            volumes: [
              {
                name: "containerd-sock",
                hostPath: {
                  path: "/run/containerd/containerd.sock",
                  type: "Socket",
                },
              },
            ],
          },
        },
      },
    },
    { provider }
  );
}
