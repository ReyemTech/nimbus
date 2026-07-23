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
 * Defaults: trigger at 75%, target 60% — low enough to prevent eviction,
 * high enough to stay above the floor of in-use images (which alone can
 * exceed 50% of a 41Gi disk and can never be pruned).
 *
 * @module platform/components/image-pruner
 */

import * as k8s from "@pulumi/kubernetes";
import type { IImagePrunerConfig } from "../interfaces";

const CRICTL_VERSION = "v1.30.0";
const DEFAULT_IMAGE = "alpine:3.20";
const DEFAULT_INTERVAL = 300; // 5 minutes
const DEFAULT_HIGH_THRESHOLD = 75; // prune when disk >= 75%
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

  // NOTE: no `set -e` — the removal loop's failing tests would kill the
  // shell (a `[ ... ] && break` list that evaluates false is a nonzero exit),
  // which previously caused a permanent CrashLoopBackOff. Errors are handled
  // explicitly instead.
  const script = `set -u
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

# The container rootfs lives on the same node disk as the containerd image
# store, so df of / tracks the disk the kubelet watches.
get_disk_pct() {
  df / | awk 'NR==2 {gsub(/%/,""); print $5}'
}

while true; do
  PCT=$(get_disk_pct)
  PCT=\${PCT:-0}
  if [ "$PCT" -ge "$HIGH" ]; then
    echo "[$(date -Iseconds)] disk at \${PCT}% (>= \${HIGH}%), pruning..."

    # 1. Remove stopped containers first — frees image references
    STOPPED=$(crictl $CRI ps -a --state exited -q 2>/dev/null || true)
    if [ -n "$STOPPED" ]; then
      echo "$STOPPED" | xargs -r crictl $CRI rm >/dev/null 2>&1 || true
      echo "[$(date -Iseconds)] cleaned stopped containers"
    fi

    # 2. Prune unreferenced images
    crictl $CRI rmi --prune >/dev/null 2>&1 || true
    PCT=$(get_disk_pct)
    echo "[$(date -Iseconds)] after prune: \${PCT}%"

    # 3. If still above low threshold, remove unused images one by one.
    #    Skip our own base image and the pod-sandbox (pause) image by repo —
    #    an ID-equality self-guard proved unreliable and once deleted both.
    if [ "$PCT" -ge "$LOW" ]; then
      REMOVED=0
      IMAGE_TABLE=$(crictl $CRI images --no-trunc 2>/dev/null || true)
      for IMG_ID in $(crictl $CRI images -q 2>/dev/null); do
        REPOS=$(echo "$IMAGE_TABLE" | awk -v id="$IMG_ID" '$3 == id {print $1}')
        case "$REPOS" in
          *${image.split(":")[0]}*|*pause*) continue ;;
        esac
        if crictl $CRI rmi "$IMG_ID" >/dev/null 2>&1; then
          REMOVED=$((REMOVED + 1))
          PCT=$(get_disk_pct)
          echo "[$(date -Iseconds)] removed $IMG_ID, now \${PCT}%"
          if [ "$PCT" -lt "$LOW" ]; then
            break
          fi
        fi
      done
      if [ "$REMOVED" -eq 0 ]; then
        echo "[$(date -Iseconds)] nothing removable; remaining usage is in-use images or non-image data"
      fi
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
