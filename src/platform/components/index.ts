/**
 * Platform component deployments.
 *
 * Each component is a self-contained Helm release deployment
 * called by the platform stack orchestrator.
 *
 * @module platform/components
 */

export { deployTraefik } from "./traefik";
export {
  HEADLAMP_PLUGIN_MANAGER_VERSION,
  deployHeadlamp,
  resolveHeadlampPlugins,
} from "./headlamp";
export { deployCertManager, certManagerServiceAccountName } from "./cert-manager";
export { deployExternalDns } from "./external-dns";
export { deployEksExternalDns } from "./external-dns-eks";
export { deployArgocd } from "./argocd";
export { deployVault } from "./vault";
export { deployExternalSecrets } from "./external-secrets";
export { deployOAuth2Proxy } from "./oauth2-proxy";
export { deployDescheduler } from "./descheduler";
export { deployTrivyOperator } from "./trivy-operator";
export { createTrivyExposureClassifier } from "./trivy-exposure-classifier";
export { createImagePruner } from "./image-pruner";
