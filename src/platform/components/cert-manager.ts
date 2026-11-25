/**
 * cert-manager TLS certificate management deployment.
 *
 * @module platform/components/cert-manager
 */

import * as k8s from "@pulumi/kubernetes";
import type * as pulumi from "@pulumi/pulumi";
import type { IPlatformComponentConfig } from "../interfaces";
import { ensureNamespace } from "../../utils/ensure-namespace";

export function deployCertManager(
  name: string,
  config: IPlatformComponentConfig | undefined,
  provider: k8s.Provider,
  defaultVersion: string | undefined,
  podIdentityAssociation?: pulumi.Resource,
  podIdentityAssociationId?: pulumi.Input<string>
): k8s.helm.v3.Release {
  ensureNamespace("cert-manager", provider);
  const serviceAccountValues =
    (config?.values?.serviceAccount as Record<string, unknown> | undefined) ?? {};
  const podAnnotations =
    (config?.values?.podAnnotations as Record<string, unknown> | undefined) ?? {};

  return new k8s.helm.v3.Release(
    `${name}-cert-manager`,
    {
      chart: "cert-manager",
      repositoryOpts: { repo: "https://charts.jetstack.io" },
      version: config?.version ?? defaultVersion,
      namespace: "cert-manager",
      createNamespace: false,
      values: {
        crds: { enabled: true },
        ...config?.values,
        ...(podIdentityAssociation && {
          serviceAccount: {
            name: certManagerServiceAccountName(config),
            ...serviceAccountValues,
          },
        }),
        ...(podIdentityAssociationId && {
          podAnnotations: {
            ...podAnnotations,
            "nimbus.dev/route53-pod-identity": podIdentityAssociationId,
          },
        }),
      },
    },
    { provider, dependsOn: podIdentityAssociation ? [podIdentityAssociation] : undefined }
  );
}

/** Return the service account name shared by the Helm chart and EKS Pod Identity. */
export function certManagerServiceAccountName(
  config: IPlatformComponentConfig | undefined
): pulumi.Input<string> {
  const serviceAccount = config?.values?.serviceAccount as
    | { readonly name?: pulumi.Input<string> }
    | undefined;
  return serviceAccount?.name ?? "cert-manager";
}
