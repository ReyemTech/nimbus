/**
 * Platform component deployments.
 *
 * Each component is a self-contained Helm release deployment
 * called by the platform stack orchestrator.
 *
 * @module platform/components
 */

export { deployTraefik } from "./traefik";
export { deployCertManager } from "./cert-manager";
export { deployExternalDns } from "./external-dns";
export { deployArgocd } from "./argocd";
export { deployVault } from "./vault";
export { deployExternalSecrets } from "./external-secrets";
export { deployOAuth2Proxy } from "./oauth2-proxy";
export { deployDescheduler } from "./descheduler";
export { createImagePruner } from "./image-pruner";
