/**
 * Unit tests for createImagePruner DaemonSet.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockProvider = (): any => ({});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let createdDaemonSets: Array<{ name: string; args: any }>;

vi.mock("@pulumi/kubernetes", () => {
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  const mockDaemonSet = class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(name: string, args: any, _opts?: any) {
      createdDaemonSets.push({ name, args });
    }
  };
  return {
    apps: { v1: { DaemonSet: mockDaemonSet } },
  };
});

beforeEach(() => {
  createdDaemonSets = [];
  vi.resetModules();
});

describe("createImagePruner", () => {
  it("returns null when enabled: false", async () => {
    const { createImagePruner } = await import(
      "../../src/platform/components/image-pruner.js"
    );
    const result = createImagePruner("test", { enabled: false }, mockProvider());
    expect(result).toBeNull();
    expect(createdDaemonSets).toHaveLength(0);
  });

  it("creates DaemonSet with privileged container, hostPath socket, default interval", async () => {
    const { createImagePruner } = await import(
      "../../src/platform/components/image-pruner.js"
    );
    const result = createImagePruner("test", {}, mockProvider());
    expect(result).not.toBeNull();
    expect(createdDaemonSets).toHaveLength(1);
    const ds = createdDaemonSets[0]!.args;
    expect(ds.metadata.namespace).toBe("kube-system");

    const container = ds.spec.template.spec.containers[0];
    expect(container.securityContext.privileged).toBe(true);
    expect(container.args.join(" ")).toContain("21600");

    const volumeMount = container.volumeMounts.find(
      (v: { name: string }) => v.name === "containerd-sock"
    );
    expect(volumeMount.mountPath).toBe("/run/containerd/containerd.sock");

    const hostPath = ds.spec.template.spec.volumes.find(
      (v: { name: string }) => v.name === "containerd-sock"
    );
    expect(hostPath.hostPath.path).toBe("/run/containerd/containerd.sock");

    const resources = container.resources;
    expect(resources.requests.cpu).toBe("50m");
    expect(resources.limits.memory).toBe("100Mi");
    expect(resources.limits["ephemeral-storage"]).toBe("50Mi");

    const tolerations = ds.spec.template.spec.tolerations;
    expect(tolerations).toContainEqual({ operator: "Exists", effect: "NoSchedule" });
  });

  it("uses custom intervalSeconds when provided", async () => {
    const { createImagePruner } = await import(
      "../../src/platform/components/image-pruner.js"
    );
    createImagePruner("test", { intervalSeconds: 3600 }, mockProvider());
    const args = createdDaemonSets[0]!.args.spec.template.spec.containers[0].args.join(" ");
    expect(args).toContain("3600");
    expect(args).not.toContain("21600");
  });

  it("uses custom namespace when provided", async () => {
    const { createImagePruner } = await import(
      "../../src/platform/components/image-pruner.js"
    );
    createImagePruner("test", { namespace: "infra" }, mockProvider());
    expect(createdDaemonSets[0]!.args.metadata.namespace).toBe("infra");
  });
});
