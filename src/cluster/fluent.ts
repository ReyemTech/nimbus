import { createAccessGateway, createServiceAccountAccess } from "../access";
import { createPlatformStack } from "../platform";
import { createObservabilityStack } from "../observability";
import { createOperator } from "../operator";
import { createArgoCD } from "../argocd";
import type { IAccessGatewayConfig } from "../access/interfaces";
import type {
  ICluster,
  IClusterFluentOperations,
  IClusterWithFluentOperations,
} from "./interfaces";

/** Attach fluent wrappers that delegate to the existing public factories. */
export function withClusterFluentOperations<T extends ICluster>(
  cluster: T
): T & IClusterWithFluentOperations {
  const operations: IClusterFluentOperations = {
    createServiceAccountAccess: (name, config) =>
      createServiceAccountAccess(name, { ...config, cluster }),
    createAccessGateway: (name, config) =>
      createAccessGateway(name, { ...config, cluster } as IAccessGatewayConfig),
    createPlatformStack: (name, config) => createPlatformStack(name, { ...config, cluster }),
    createObservabilityStack: (name, config) =>
      createObservabilityStack(name, { ...config, cluster }),
    createOperator: (type, config) => createOperator(type, { ...config, cluster }),
    createArgoCD: (name, config) => createArgoCD(name, { ...config, cluster }),
  };
  return Object.assign(cluster, operations);
}
