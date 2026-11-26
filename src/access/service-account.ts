/**
 * Creates portable Kubernetes access backed by a persistent ServiceAccount token.
 *
 * @module access/service-account
 */

import * as k8s from "@pulumi/kubernetes";
import * as pulumi from "@pulumi/pulumi";
import type { IServiceAccountAccess, IServiceAccountAccessConfig } from "./interfaces";
import { ensureNamespace } from "../utils/ensure-namespace";

const DEFAULT_NAMESPACE = "nimbus-access";

/** Create a ServiceAccount, scoped RBAC binding, token Secret and kubeconfig. */
export function createServiceAccountAccess(
  name: string,
  config: IServiceAccountAccessConfig
): IServiceAccountAccess {
  const namespace = config.namespace ?? DEFAULT_NAMESPACE;
  const scope = config.scope;
  if (!name.trim()) throw new Error("ServiceAccount access name must not be empty");
  if (!namespace.trim()) throw new Error("ServiceAccount namespace must not be empty");

  const bindingNamespace =
    scope.type === "namespace"
      ? scope.namespace
      : scope.type === "custom"
        ? scope.namespace
        : undefined;
  if (scope.type === "namespace" && !scope.namespace.trim()) {
    throw new Error("Namespace scope requires a non-empty namespace");
  }
  if (scope.type === "custom") {
    if (!scope.roleRef.name.trim()) throw new Error("Custom role reference name must not be empty");
    if (scope.roleRef.kind === "Role" && !scope.namespace?.trim()) {
      throw new Error("A custom Role reference requires a namespace");
    }
  }

  const provider = config.cluster.provider;
  const ns = ensureNamespace(namespace, provider, { policy: false });
  const serviceAccount = new k8s.core.v1.ServiceAccount(
    `${name}-service-account`,
    { metadata: { name, namespace }, automountServiceAccountToken: false },
    { provider, dependsOn: [ns] }
  );
  const tokenSecret = new k8s.core.v1.Secret(
    `${name}-access-token`,
    {
      metadata: {
        name: `${name}-token`,
        namespace,
        annotations: {
          "kubernetes.io/service-account.name": name,
          "pulumi.com/waitFor": "jsonpath={.data.token}",
        },
      },
      type: "kubernetes.io/service-account-token",
    },
    { provider, dependsOn: [serviceAccount] }
  );

  const subject = [{ kind: "ServiceAccount", name, namespace, apiGroup: "" }];
  const roleRef =
    scope.type === "custom"
      ? {
          apiGroup: "rbac.authorization.k8s.io",
          kind: scope.roleRef.kind,
          name: scope.roleRef.name,
        }
      : {
          apiGroup: "rbac.authorization.k8s.io",
          kind: "ClusterRole",
          name: scope.role,
        };

  const binding = bindingNamespace
    ? new k8s.rbac.v1.RoleBinding(
        `${name}-binding`,
        {
          metadata: { name: `${name}-access`, namespace: bindingNamespace },
          roleRef,
          subjects: subject,
        },
        { provider, dependsOn: [serviceAccount] }
      )
    : new k8s.rbac.v1.ClusterRoleBinding(
        `${name}-binding`,
        { metadata: { name: `${name}-access` }, roleRef, subjects: subject },
        { provider, dependsOn: [serviceAccount] }
      );

  const server = config.server ?? config.cluster.endpoint;
  const kubeconfig = pulumi.secret(
    pulumi.all([server, tokenSecret.data]).apply(([resolvedServer, data]) => {
      const token = data?.token;
      const certificateAuthorityData = data?.["ca.crt"];
      if (typeof token !== "string" || token.length === 0) {
        throw new Error(
          `ServiceAccount token Secret ${namespace}/${name}-token has no token data; ensure the Kubernetes controller populated it before exporting kubeconfig.`
        );
      }
      if (typeof certificateAuthorityData !== "string" || certificateAuthorityData.length === 0) {
        throw new Error(
          `ServiceAccount token Secret ${namespace}/${name}-token has no ca.crt data; ensure the Kubernetes controller populated it before exporting kubeconfig.`
        );
      }
      const bearerToken = Buffer.from(token, "base64").toString("utf8");
      if (!bearerToken) {
        throw new Error(
          `ServiceAccount token Secret ${namespace}/${name}-token contains invalid base64 token data.`
        );
      }
      if (typeof resolvedServer !== "string" || resolvedServer.length === 0) {
        throw new Error(
          "Kubernetes API endpoint is required to generate a ServiceAccount kubeconfig"
        );
      }
      const context = `${name}@${config.cluster.name}`;
      return JSON.stringify(
        {
          apiVersion: "v1",
          kind: "Config",
          clusters: [
            {
              name: config.cluster.name,
              cluster: {
                server: resolvedServer,
                "certificate-authority-data": certificateAuthorityData,
              },
            },
          ],
          users: [{ name, user: { token: bearerToken } }],
          contexts: [
            {
              name: context,
              context: {
                cluster: config.cluster.name,
                user: name,
                namespace: bindingNamespace ?? namespace,
              },
            },
          ],
          "current-context": context,
        },
        null,
        2
      );
    })
  );

  return { name, namespace, serviceAccount, tokenSecret, binding, kubeconfig };
}
