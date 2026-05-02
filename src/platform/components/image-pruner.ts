/**
 * Disk-pressure-aware image pruner DaemonSet.
 *
 * Checks node disk usage every N seconds. When usage exceeds the high
 * threshold, prunes stopped containers (freeing image refs) then removes
 * unused images until usage drops below the low threshold or no more
 * images can be removed.
 *
 * Runs well below kubelet's imageGC (85%) and eviction (90%) thresholds
 * to prevent DiskPressure cascades on small root disks (e.g. 38Gi).
 *
 * @module platform/components/image-pruner
 */

import * as k8s from "@pulumi/kubernetes";
import type { IImagePrunerConfig } from "../interfaces";

const CRICTL_VERSION = "v1.30.0";
const DEFAULT_IMAGE = "alpine:3.20";
const DEFAULT_INTERVAL = 300; // 5 minutes
const DEFAULT_HIGH_THRESHOLD = 70; // prune when disk >= 70%
const DEFAULT_LOW_THRESHOLD = 60; // prune until disk <= 60%
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
  const highPct = config.highThresholdPercent ?? DEFAULT_HIGH_THRESHOLD;
  const lowPct = config.lowThresholdPercent ?? DEFAULT_LOW_THRESHOLD;
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

CRI="--runtime-endpoint unix:///run/containerd/containerd.sock"
HIGH=${highPct}
LOW=${lowPct}

get_disk_pct() {
  df /run/containerd | awk 'NR==2 {gsub(/%/,""); print $5}'
}

while true; do
  PCT=$(get_disk_pct)
  if [ "$PCT" -ge "$HIGH" ]; then
    echo "[$(date -Iseconds)] disk at \${PCT}% (>= \${HIGH}%), pruning..."

    # 1. Remove stopped containers first — frees image references
    STOPPED=$(crictl $CRI ps -a --state exited -q 2>/dev/null || true)
    if [ -n "$STOPPED" ]; then
      echo "$STOPPED" | xargs -r crictl $CRI rm 2>/dev/null || true
      echo "[$(date -Iseconds)] cleaned stopped containers"
    fi

    # 2. Prune all fully-unreferenced images
    crictl $CRI rmi --prune 2>/dev/null || true
    PCT=$(get_disk_pct)
    echo "[$(date -Iseconds)] after prune: \${PCT}%"

    # 3. If still above low threshold, remove oldest unused images one by one
    if [ "$PCT" -ge "$LOW" ]; then
      echo "[$(date -Iseconds)] still at \${PCT}%, removing oldest images..."
      crictl $CRI images -q 2>/dev/null | while read -r IMG_ID; do
        crictl $CRI rmi "$IMG_ID" 2>/dev/null || continue
        PCT=$(get_disk_pct)
        echo "[$(date -Iseconds)] removed $IMG_ID, now \${PCT}%"
        [ "$PCT" -lt "$LOW" ] && break
      done
    fi

    PCT=$(get_disk_pct)
    echo "[$(date -Iseconds)] done, disk at \${PCT}%"
  fi
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
