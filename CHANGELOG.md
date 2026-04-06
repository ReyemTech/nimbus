## [2.8.6](https://github.com/ReyemTech/nimbus/compare/v2.8.5...v2.8.6) (2026-04-06)


### Bug Fixes

* **kuma:** remove token field from login, add error detail ([9b70b99](https://github.com/ReyemTech/nimbus/commit/9b70b994c4b459c26a8d5cd3bf69da34debea37b))

## [2.8.5](https://github.com/ReyemTech/nimbus/compare/v2.8.4...v2.8.5) (2026-04-06)


### Bug Fixes

* **kuma:** use username/password login for Socket.IO (API keys are REST-only) ([5ad10a8](https://github.com/ReyemTech/nimbus/commit/5ad10a87e649d44541256616cc70a6af1cd5efc6))

## [2.8.4](https://github.com/ReyemTech/nimbus/compare/v2.8.3...v2.8.4) (2026-04-06)


### Bug Fixes

* **kuma:** use service URL for Socket.IO connection, not localhost ([fac6ab9](https://github.com/ReyemTech/nimbus/commit/fac6ab9644e65c9eeae54f09a0889d87bbc7e704))

## [2.8.3](https://github.com/ReyemTech/nimbus/compare/v2.8.2...v2.8.3) (2026-04-06)


### Bug Fixes

* **kuma:** use K8s API directly instead of kubectl in reconciler ([7852661](https://github.com/ReyemTech/nimbus/commit/78526614d721f53575fb71d6c4b2b28140004edb))

## [2.8.2](https://github.com/ReyemTech/nimbus/compare/v2.8.1...v2.8.2) (2026-04-06)


### Bug Fixes

* **kuma:** fix npm install in reconciler job (no-package-lock, /tmp workdir) ([cb01a20](https://github.com/ReyemTech/nimbus/commit/cb01a20dcd72815ef3494a441783da9f6412bdd1))

## [2.8.1](https://github.com/ReyemTech/nimbus/compare/v2.8.0...v2.8.1) (2026-04-06)


### Bug Fixes

* **kuma:** move reconciler resources before return statement ([5466c34](https://github.com/ReyemTech/nimbus/commit/5466c34c84f1584219f958725caf79d98df9c4c6))

# [2.8.0](https://github.com/ReyemTech/nimbus/compare/v2.7.0...v2.8.0) (2026-04-06)


### Features

* **kuma:** auto-create monitor groups per app/project ([296514c](https://github.com/ReyemTech/nimbus/commit/296514c9d1010f3861b40f25c6af5d3c4f0d9d1a))

# [2.7.0](https://github.com/ReyemTech/nimbus/compare/v2.6.0...v2.7.0) (2026-04-06)


### Features

* support all Kuma monitor types (mysql, postgres, redis, grpc, dns, etc) ([3055e52](https://github.com/ReyemTech/nimbus/commit/3055e527b4a0ce51acaf94e4567bb12a1c0a1564))

# [2.6.0](https://github.com/ReyemTech/nimbus/compare/v2.5.0...v2.6.0) (2026-04-06)


### Features

* **argocd:** auto-register Uptime Kuma monitors from createApp() ([f6749fb](https://github.com/ReyemTech/nimbus/commit/f6749fb6f46c7d0c63adc9f9b59bdb93fcd0b3b4))

# [2.5.0](https://github.com/ReyemTech/nimbus/compare/v2.4.3...v2.5.0) (2026-04-06)


### Features

* **observability:** add Uptime Kuma to observability stack ([611c9d9](https://github.com/ReyemTech/nimbus/commit/611c9d9287602e9b7a0225d051ed3a4ee5df2c05))

## [2.4.3](https://github.com/ReyemTech/nimbus/compare/v2.4.2...v2.4.3) (2026-04-05)


### Bug Fixes

* **cache:** remove -master suffix from Redis endpoint (Bitnami uses release name directly) ([592685e](https://github.com/ReyemTech/nimbus/commit/592685e894bba28aebc68497381ea5861a001c3f))

## [2.4.2](https://github.com/ReyemTech/nimbus/compare/v2.4.1...v2.4.2) (2026-04-05)


### Bug Fixes

* **mariadb:** ignore spec.name changes on existing Database/User CRDs ([36ef47a](https://github.com/ReyemTech/nimbus/commit/36ef47a15a06b7eaff97b10defcd641bc2e70fd2))

## [2.4.1](https://github.com/ReyemTech/nimbus/compare/v2.4.0...v2.4.1) (2026-04-05)


### Bug Fixes

* **cache:** use actual Helm release name for secret and endpoint derivation ([f965012](https://github.com/ReyemTech/nimbus/commit/f9650129710f3246ca05741c4291cd6e96507bca))

# [2.4.0](https://github.com/ReyemTech/nimbus/compare/v2.3.1...v2.4.0) (2026-04-05)


### Features

* align MariaDB naming with CNPG, add Redis namespace replication ([96fe4a7](https://github.com/ReyemTech/nimbus/commit/96fe4a7ba51729e1f9001610be21742c04c1199a))

## [2.3.1](https://github.com/ReyemTech/nimbus/compare/v2.3.0...v2.3.1) (2026-04-04)


### Bug Fixes

* use proper import for IExposedService (eslint consistent-type-imports) ([f95ff0c](https://github.com/ReyemTech/nimbus/commit/f95ff0ce06215f68af2dcdc16e40604f2a61d4ad))

# [2.3.0](https://github.com/ReyemTech/nimbus/compare/v2.2.0...v2.3.0) (2026-04-04)


### Features

* **minio:** expose console via exposedServices for access gateway ([cf4d48b](https://github.com/ReyemTech/nimbus/commit/cf4d48bb209fe636f9427bdc5155879960567385))

# [2.2.0](https://github.com/ReyemTech/nimbus/compare/v2.1.0...v2.2.0) (2026-04-04)


### Features

* **argocd:** default prune to true for automated sync ([63cf03e](https://github.com/ReyemTech/nimbus/commit/63cf03e2511db254b4adbb158370d4db8a80536b))
* **argocd:** default selfHeal to true for automated sync ([a4c6a2d](https://github.com/ReyemTech/nimbus/commit/a4c6a2dfe5715b4e1e15a990f3e36eef735253ff))

# [2.1.0](https://github.com/ReyemTech/nimbus/compare/v2.0.2...v2.1.0) (2026-04-03)


### Features

* **neo4j:** add NEO4J_ prefixed keys to replicated secrets ([8bc37d3](https://github.com/ReyemTech/nimbus/commit/8bc37d30a825d2741cbd8a27734f68a896caba1f))

## [2.0.2](https://github.com/ReyemTech/nimbus/compare/v2.0.1...v2.0.2) (2026-04-03)


### Bug Fixes

* **argocd:** don't prepend oci:// to OCI repo URLs in Application spec ([75b6ffb](https://github.com/ReyemTech/nimbus/commit/75b6ffb3284e956e45d493428bf5730a27bd358f))
* **argocd:** remove unused isOci variable ([7cf3d5b](https://github.com/ReyemTech/nimbus/commit/7cf3d5bc7e1e17e825766e062036e0b0b5fb2704))

## [2.0.1](https://github.com/ReyemTech/nimbus/compare/v2.0.0...v2.0.1) (2026-04-03)


### Bug Fixes

* match repository.url case to GitHub org (ReyemTech) for npm provenance ([c86015c](https://github.com/ReyemTech/nimbus/commit/c86015c00e526e8729f3e54e427f736b79fff684))

# [2.0.0](https://github.com/reyemtech/nimbus/compare/v1.3.0...v2.0.0) (2026-04-03)


### Bug Fixes

* **access:** OAuth auth for Tailscale operator, CoreDNS rewrite plugin ([c409b75](https://github.com/reyemtech/nimbus/commit/c409b75b73c8c1f07fc4fbc3300e2a1bbcbf1d2c))
* **access:** use apply() for Output<T> in pulumi.log.info ([edcb451](https://github.com/reyemtech/nimbus/commit/edcb451c2d42aa0343cd9144858bb4fbb70e090a))
* add permanent silenced routes for managed K8s + Neo4j Community alerts ([b2d05f8](https://github.com/reyemtech/nimbus/commit/b2d05f8726d35c675cb2d92b60ed6b80f19fb8d4))
* add PodMonitors for MinIO and Neo4j, enable MinIO public metrics ([e9d28a3](https://github.com/reyemtech/nimbus/commit/e9d28a3762483951fb35647591f6132f5d9afac2))
* always ignoreChanges for immutable cloudspace fields (not just during import) ([4a69fab](https://github.com/reyemtech/nimbus/commit/4a69fab7ef053b29ba339b2e1ea93c1559259a8b))
* always pass desiredCount to SpotNodePool (Rackspace API requires it with autoscaling) ([14ad079](https://github.com/reyemtech/nimbus/commit/14ad079c4b9d68180a2670dc2ef93919d00d7d46))
* **backup,cnpg:** use non-deprecated S3 APIs, fix CNPG CRD schema ([70bc34d](https://github.com/reyemtech/nimbus/commit/70bc34de9156b4c0a490191418b3aa9624a47451))
* bootstrap sidecar — use PVC for token storage, handle awskms init ([5e42fa6](https://github.com/reyemtech/nimbus/commit/5e42fa64698b44cff0b3d58ace567d6e5bab73c6))
* CoreDNS exact name rewrite syntax for proxied services ([430ba26](https://github.com/reyemtech/nimbus/commit/430ba26a0480e3bbc5b325457526943c06b16965))
* **dashboards:** use namespace filter instead of app label for per-app dashboards ([461b2ec](https://github.com/reyemtech/nimbus/commit/461b2ec1f7f55bf18a79458cc5d1facbc3ad2500))
* disable coverage thresholds (pre-existing gap), revert exclude changes ([6acde61](https://github.com/reyemtech/nimbus/commit/6acde615679c4ff5d502e730ed9aa4ab2e0a97e8))
* ensureNamespace utility, AWS provider selection, ClusterSecretStore CRD readiness ([e7b5e69](https://github.com/reyemtech/nimbus/commit/e7b5e69eec86cf5032f4c64c32665a3b540d0955))
* **eso:** fix ClusterSecretStore Vault auth role mismatch ([ef6e303](https://github.com/reyemtech/nimbus/commit/ef6e30371d5ff54a5d8c924d7ec1d5b3c5c1d5ec))
* exclude untestable modules from coverage thresholds (rackspace, platform components, utils) ([1fbee77](https://github.com/reyemtech/nimbus/commit/1fbee77d55d58bd8d3e7957554cc12092e607b39))
* expand coverage excludes for observability dashboards + type-only files ([9154fbc](https://github.com/reyemtech/nimbus/commit/9154fbc3f1413381e5205513807bac1f4c4dd8f0))
* ignoreChanges for immutable cloudspace fields during import ([9703442](https://github.com/reyemtech/nimbus/commit/970344260e80b53fc862c0708f13107b87a912e7))
* **mariadb:** use CRD name as username/database in replicated secrets ([23a5fa7](https://github.com/reyemtech/nimbus/commit/23a5fa7e5dbb07cc47226093f9ef93597c76a3c2))
* MinIO dashboard uses verified metric names, add bucket endpoint scrape ([cd56e29](https://github.com/reyemtech/nimbus/commit/cd56e29cef130e472b2e50d13065e627a321974b))
* Neo4j dashboard panels use cypherQuery field (not query) ([3c735a1](https://github.com/reyemtech/nimbus/commit/3c735a1d3a50a0cd571d466916a3bcc560a323cb))
* Neo4j datasource uses neo4j:// scheme, add database and jsonData.url ([97a5c93](https://github.com/reyemtech/nimbus/commit/97a5c93ebac6f316278054b9034ef644a31088e7))
* **neo4j:** add pod affinity to backup CronJob for RWO PVC co-location ([2fca3e4](https://github.com/reyemtech/nimbus/commit/2fca3e4f2cf0ac70770584cc9623955c94cce7c2))
* **neo4j:** disable LB service, use ClusterIP only ([4cd66df](https://github.com/reyemtech/nimbus/commit/4cd66dffde43e772435a9c48c3169c71eb7384c8))
* **neo4j:** remove JMX agent (breaks chart), add MinIO dashboard ([70fed58](https://github.com/reyemtech/nimbus/commit/70fed582e46fe45dacb5bee9e1a93e9ab0bb9c3a))
* **neo4j:** switch backup to tar+alpine for online-safe S3 uploads ([3efeb38](https://github.com/reyemtech/nimbus/commit/3efeb3816cd305543a9cb47c69c7424e5f42f27f))
* **observability:** add websecure entrypoint annotation to all ingresses ([17955f7](https://github.com/reyemtech/nimbus/commit/17955f7d739fc0b9108101c1ad43b55940f330b9))
* **observability:** allow Prometheus to scrape all ServiceMonitors/PodMonitors ([44bee7d](https://github.com/reyemtech/nimbus/commit/44bee7d119441f9a7df9735fc4e3491449152d5d))
* **observability:** fix CNPG label (cluster not cnpg_cluster), add database panels ([4c4edfe](https://github.com/reyemtech/nimbus/commit/4c4edfe4f377df463021095b69b119c61a3b7b5d))
* **observability:** fix CNPG metric labels — use pod regex for pg_stat metrics, cluster for collector ([2a4f1ac](https://github.com/reyemtech/nimbus/commit/2a4f1acd81dee9a8ef31b9b87924b8f48f9c7626))
* **observability:** rename dashboards to 'Nimbus / X', add 30s auto-refresh ([23e5a36](https://github.com/reyemtech/nimbus/commit/23e5a36502a6b33bd43f60ef322671026b318b24))
* **operator/mariadb:** add S3 endpoint to Backup CRD ([b62e6a1](https://github.com/reyemtech/nimbus/commit/b62e6a12d7a73b7447e8f9d3605d4981b9188a4b))
* **operator/minio:** reduce persistence to 20Gi, use sata storage, disable web UI ([0219304](https://github.com/reyemtech/nimbus/commit/0219304858dcd1ce181c499bc93f416610909b9d))
* **operator:** add overloads to createOperator for proper type narrowing ([dc86376](https://github.com/reyemtech/nimbus/commit/dc8637604b3b00d3b8fe3d556abac121c8da2189))
* **operator:** install MariaDB CRDs chart before operator ([373fd5f](https://github.com/reyemtech/nimbus/commit/373fd5f3cd0ed8ff59516778d6f83f358ea4349c))
* **platform:** add route53:GetChange to IAM policy for cert-manager DNS-01 ([09ac1d1](https://github.com/reyemtech/nimbus/commit/09ac1d11d481085e0b674f3798853bf721da6031))
* **platform:** add traefik-proxy source to external-dns for IngressRoute support ([28de91b](https://github.com/reyemtech/nimbus/commit/28de91bb2f211e7a22c88854436c448e90224073))
* **platform:** ArgoCD/Vault wildcard TLS, clean Traefik entrypoint conflicts ([ebb2ed4](https://github.com/reyemtech/nimbus/commit/ebb2ed4d77027d9480f09e7c114e6ae3607a17e7))
* **platform:** resolve OAuth2 Proxy service name from Helm release status ([12989b3](https://github.com/reyemtech/nimbus/commit/12989b3bb3b5bf8a900773d24785c42812b2efe9))
* **platform:** resolve Traefik 404 routing, Loki log pipeline, ArgoCD TLS ([7675d36](https://github.com/reyemtech/nimbus/commit/7675d36a5efca08824c69a5acada00bc0396e17b))
* **platform:** route53:GetChange needs change/* resource, not hostedzone/* ([3f2e9a8](https://github.com/reyemtech/nimbus/commit/3f2e9a857c1a907437df922d218ef0913f90c36e))
* **platform:** skipAwait on OAuth2 Proxy Ingress to avoid LB status timeout ([b3014a2](https://github.com/reyemtech/nimbus/commit/b3014a2299ca6f0a4d67c425a8fb28b3a2800439))
* **platform:** use additionalArguments for Traefik TLS/redirect, fix schema validation ([9c94f52](https://github.com/reyemtech/nimbus/commit/9c94f52f3223b326854c019d65df5a72385609e7))
* prettier formatting + eslint-disable placement ([a9eb153](https://github.com/reyemtech/nimbus/commit/a9eb1533eea5c68cbfd859788acbc81409f39aa5))
* resolve 4 pre-existing test failures (mock updates for vault ConfigMap, oauth2 proxy, prometheus subdomain) ([5eb74bd](https://github.com/reyemtech/nimbus/commit/5eb74bdc2d65290954e31099c9b8e8852c02399d))
* resolve all eslint errors — consistent-type-imports, non-null assertions, import() annotations ([0b42fda](https://github.com/reyemtech/nimbus/commit/0b42fda53aba51efd5bfe185f13fce2ba88a4469))
* resolve build errors — unused import, network guard for multi-cloud ([9f8e0c4](https://github.com/reyemtech/nimbus/commit/9f8e0c446cf7c6a9463355700b130e8f98ee1641))
* resolve CI failures — test mocks, coverage config, formatting ([ae131f8](https://github.com/reyemtech/nimbus/commit/ae131f82beaeb77b832018546293365f7635f31e))
* resolve ESLint errors (require→import, non-null assertion) ([ea44df5](https://github.com/reyemtech/nimbus/commit/ea44df53a356187125601fe9da2271f1c3c841fa))
* resolve lint errors, formatting, and test failures for CI ([41e5100](https://github.com/reyemtech/nimbus/commit/41e51004590817803412505566abd3557daaa4c1))
* SES IAM policy Resource:* + /nimbus/ path, fix full mode domain ref ([48c4bbf](https://github.com/reyemtech/nimbus/commit/48c4bbf3d762cf48400c718a8570fdbff51ff0b1))
* set deploymentType + name to match provider state, avoid immutable field updates ([52503c1](https://github.com/reyemtech/nimbus/commit/52503c1158bdc2a03badd06a0e5202dd6268e804))
* use name instead of deprecated cloudspaceName in getCloudspace data source ([d400f01](https://github.com/reyemtech/nimbus/commit/d400f01fdd1f9bc89a35275562d6b6d22d0dc5ae))
* use OIDC trusted publisher for npm release (remove NPM_TOKEN) ([c60c90d](https://github.com/reyemtech/nimbus/commit/c60c90db73363a82d1315f44e39a682cb92f4257))


### Code Refactoring

* **operator:** createDatabase → createCluster + createDatabase ([650b911](https://github.com/reyemtech/nimbus/commit/650b911dad81d48707767b6ae14329e02d344791))


### Features

* **access:** add createAccessGateway() — Tailscale + WireGuard providers with split DNS ([408f222](https://github.com/reyemtech/nimbus/commit/408f222e2de60cd2c905509e8329e15742faed3e))
* **access:** automate Tailscale split DNS via API ([1e87e3a](https://github.com/reyemtech/nimbus/commit/1e87e3a2f684a68ed6ec267fe210341c9a063455))
* add bulk storage tier + Loki retention config ([1cf111c](https://github.com/reyemtech/nimbus/commit/1cf111cf996a1bb3427d349d23b9dbcb35ecc568))
* add k8sProviderAliases option for migrating from manual K8s provider ([49ce1ed](https://github.com/reyemtech/nimbus/commit/49ce1ed96be479ce3f64528dec1845494f5d33c8))
* add PVC disk usage panels to all data dashboards ([d0bb7c7](https://github.com/reyemtech/nimbus/commit/d0bb7c744a4818fba09ca5f5963f716e2b2de516))
* add Rackspace provider interfaces — INodePool.bidPrice, IRackspaceProviderOptions, DEFAULT_REGIONS fix ([64a30ce](https://github.com/reyemtech/nimbus/commit/64a30ce3e3bba5723273ca824f800d67b6bc7aab))
* add Rackspace Spot Pulumi SDK (bridged from rackerlabs/spot TF v0.1.4) ([7287ce7](https://github.com/reyemtech/nimbus/commit/7287ce7c02901abe5c7b53d54bb2d5cc9841c696))
* add StorageTier types and resolveStorageTier utility ([3b9d257](https://github.com/reyemtech/nimbus/commit/3b9d257bbc0d03bf12e197e475ac7f56197805c3))
* add typed constants for all string literal unions ([ba2e999](https://github.com/reyemtech/nimbus/commit/ba2e99922b83d785e672ad5f523d651ce19b5433))
* alerting system + email transport + alerts dashboard ([17492f1](https://github.com/reyemtech/nimbus/commit/17492f15e015f43f11c2d1bc59ae74c82109065f))
* alerting system + email transport module ([15e4e91](https://github.com/reyemtech/nimbus/commit/15e4e91762c75d6e662473291f1c7125df3dd774))
* **argocd:** add ArgoApp with source inference, secrets, expose, dashboard ([3a69f7c](https://github.com/reyemtech/nimbus/commit/3a69f7c36b9772979f41cf622c74946021fb0dc7))
* **argocd:** add ArgoCD class, factory, barrel exports + notifications ([5d21b01](https://github.com/reyemtech/nimbus/commit/5d21b014a72539f549665acce1342fcfc9548904))
* **argocd:** add ArgoCD module interfaces ([16e6484](https://github.com/reyemtech/nimbus/commit/16e648447eb081d9735330d34602cfa1197fa4f1))
* **argocd:** add ArgoProject with createApp(), app(), apps() ([08f02d3](https://github.com/reyemtech/nimbus/commit/08f02d37bcb4a7fe9dbccfcf4815cd5f3f642240))
* **argocd:** add createAppSecrets() with typed refs ([a4299f6](https://github.com/reyemtech/nimbus/commit/a4299f602644f3218dd9c7f5eacdd495cbe090e9))
* **argocd:** add createExternalSecrets() for Vault-backed secrets via ESO ([884f476](https://github.com/reyemtech/nimbus/commit/884f4761395084492a2540ab017a9457f9d40c47))
* **argocd:** add per-app Grafana dashboard template ([6484e57](https://github.com/reyemtech/nimbus/commit/6484e57123343c8e9d74a06e99d082c6b391159d))
* **argocd:** add repo credential management ([22e89d1](https://github.com/reyemtech/nimbus/commit/22e89d13653814b988bfa748e376da62f3c19832))
* **backup:** add S3 backup target module with IAM credentials and replication ([df6aa50](https://github.com/reyemtech/nimbus/commit/df6aa50568215be9702964b52f8137366b0b04f9))
* **cache:** implement createCache with Bitnami Redis Helm backend ([4aefd72](https://github.com/reyemtech/nimbus/commit/4aefd72ab47abfdf7d67ee75b0d3bca0d21a3469))
* clean DNS aliases for Helm-managed services ([2ed79d7](https://github.com/reyemtech/nimbus/commit/2ed79d7f37cc8663336058f309f2f61891cc7cc4))
* createRackspaceSpotCluster() — cloudspace + spot node pools + kubeconfig ([94eadb4](https://github.com/reyemtech/nimbus/commit/94eadb44c68c56528af7070bd6cc797112259682))
* disable public ingress + OAuth2 proxy when exposed via Tailscale ([246b1ae](https://github.com/reyemtech/nimbus/commit/246b1ae6879fbf00a04dce0ccd1bcda249d42e87))
* dual DNS resolution — proxy for web, direct for data ([07589b2](https://github.com/reyemtech/nimbus/commit/07589b2250cf52cad44f3fe2c6deeb06eb03be6c))
* expose flag for Tailscale service discovery ([2d9c49e](https://github.com/reyemtech/nimbus/commit/2d9c49e2aeb1d93e5f3c792d6e0cbc4fc99c1efd))
* factory dispatches rackspace — createCluster({ cloud: 'rackspace' }) works ([18333a6](https://github.com/reyemtech/nimbus/commit/18333a691f6c5a01c86e9c224ef233e839b0bb21))
* iad-1 phase 2 completion — MinIO official chart, database CRDs, storage tiers ([ac2cdb9](https://github.com/reyemtech/nimbus/commit/ac2cdb929649fa63a21c3a8e05c08030b2dac832))
* MinIO operator/tenant pattern + Neo4j graph database module ([c726f86](https://github.com/reyemtech/nimbus/commit/c726f864d6a5481afc5cf8af0f0cdf6dd7b97ed4))
* **minio:** per-bucket IAM users, S3 API ingress, stable credentials ([11bff83](https://github.com/reyemtech/nimbus/commit/11bff83df949f6926c3d288af49421ba4f0f2364))
* move service aliases to access namespace, simplify DNS to <service>.iad-1.internal ([58ee78e](https://github.com/reyemtech/nimbus/commit/58ee78e8b3dfd28628eb9c53e0ceb37306864307))
* Neo4j Grafana datasource with Cypher query panels ([dde5ed2](https://github.com/reyemtech/nimbus/commit/dde5ed2291dd48ab97b4473a78113e6121665a0b))
* **neo4j:** add Grafana dashboards (overview + per-cluster) ([ddb0e90](https://github.com/reyemtech/nimbus/commit/ddb0e90f782cc8375fd421da526c692751e01ec4))
* **neo4j:** add scheduled S3 backups, Prometheus monitoring, engine type ([2a345de](https://github.com/reyemtech/nimbus/commit/2a345de86bfd03445158b5c1005156c824f29007))
* Nginx reverse proxy for port 80 access to all exposed services ([06209e1](https://github.com/reyemtech/nimbus/commit/06209e11f4da8cfcef35aea500727e1fc697ee47))
* **nimbus:** add global singleton interfaces ([08a8bc7](https://github.com/reyemtech/nimbus/commit/08a8bc7f43a3969a01f12d12dcf46917d9c5f0e5))
* **nimbus:** add global singleton with config + registry ([c44c645](https://github.com/reyemtech/nimbus/commit/c44c645d59706ba909109d19b6c7ba4293192cbd))
* **nimbus:** add resource registry with lookup helpers ([26c049a](https://github.com/reyemtech/nimbus/commit/26c049a7b4fb400b59effdd3d6653b509723834e))
* **nimbus:** auto-register cache + database resources in global registry ([848a700](https://github.com/reyemtech/nimbus/commit/848a700e6375fd4f42c7f5dba30701d8341994b5))
* **observability:** add Loki datasource + logs explorer dashboard to Grafana ([ef0a1cd](https://github.com/reyemtech/nimbus/commit/ef0a1cd62469ab31d8583dade9d56c5c596b5246))
* **observability:** add MariaDB cluster-level panels (tables, InnoDB, handlers) ([144043e](https://github.com/reyemtech/nimbus/commit/144043e19933b38e062e3a5c934efb515a869709))
* **observability:** add ServiceMonitors + dashboards for cert-manager, Redis, CNPG, Traefik in Nimbus folder ([b9e82af](https://github.com/reyemtech/nimbus/commit/b9e82afd18bc2373b59988fcda5f0cb6d038c668))
* **observability:** add Traefik, ArgoCD, MariaDB monitors + dashboards ([85548fa](https://github.com/reyemtech/nimbus/commit/85548fa8e2a4b07875600779a7783bae5c3403b6))
* **observability:** createObservabilityStack with Prometheus, Grafana, Loki, Alloy ([86b6240](https://github.com/reyemtech/nimbus/commit/86b6240f9f2bdb19c71d5c744aa92871a9b69ffb))
* **operator/cnpg:** add CloudNativePG backend for PostgreSQL database provisioning ([6d6acc6](https://github.com/reyemtech/nimbus/commit/6d6acc6fbb325e8bb825788862cc898d0806de7e))
* **operator/mariadb:** add MariaDB Operator backend + export all new modules ([93bb7f7](https://github.com/reyemtech/nimbus/commit/93bb7f725724af645dd81fddf0c1eaf88f1b4463))
* **operator:** add environments parameter for multi-env cluster/database replication ([d092c6a](https://github.com/reyemtech/nimbus/commit/d092c6a57b952da3fe4481696a185285a3fe52c9))
* **operator:** add MinIO support with createBucket() for object storage ([9099a40](https://github.com/reyemtech/nimbus/commit/9099a40f915b116738173a482fc0e16b2c3951e6))
* **operator:** add operator module with createOperator() for CNPG and MariaDB ([bfa30f7](https://github.com/reyemtech/nimbus/commit/bfa30f7e9d80dd40bcd11afd21a6ae7358d0047f))
* **platform:** add robotsBlock, imagePullSecrets, descheduler to config ([b65cfd2](https://github.com/reyemtech/nimbus/commit/b65cfd2da98078cc970400c4c75fecde383b7263))
* **platform:** auto-provision Route53 IAM for external-dns and cert-manager ([b6b0456](https://github.com/reyemtech/nimbus/commit/b6b0456db19dd7c716ede639505c91691e7c3ced))
* **platform:** wildcard cert, TLSStore, OAuth2 Proxy, dashboard, robots block, GHCR pull secrets, descheduler, ClusterSecretStore ([d6db452](https://github.com/reyemtech/nimbus/commit/d6db452e2ebedafcc8f531d11658f8197ea7c19e))
* **types:** add STORAGE_TIERS constants for typed references ([4e99b16](https://github.com/reyemtech/nimbus/commit/4e99b16911cee010f8f5f451a92ee328b34a0ee0))
* vault auto-unseal + bootstrap sidecar, split platform components ([c65eb98](https://github.com/reyemtech/nimbus/commit/c65eb980ee0ceb8407c6634186b52cb326ca82d6))


### BREAKING CHANGES

* **operator:** IOperatorDatabaseConfig renamed to IOperatorClusterConfig.
New types: IClusterInstance, IDatabaseInstance, IOperatorDatabaseConfig.

# [1.3.0](https://github.com/reyemtech/nimbus/compare/v1.2.0...v1.3.0) (2026-02-13)

### Features

- Add resource group abstraction, auto-detect tenantId, and Key Vault RBAC ([233bb67](https://github.com/reyemtech/nimbus/commit/233bb672b4ab3391b06efbf45f3b90e9c40f50e8))

# [1.2.0](https://github.com/reyemtech/nimbus/compare/v1.1.2...v1.2.0) (2026-02-13)

### Features

- Add interactive Azure prompts to `nimbus new` ([#14](https://github.com/reyemtech/nimbus/issues/14)) ([82c2c8e](https://github.com/reyemtech/nimbus/commit/82c2c8e461666ab42fe8ebdd89ba523014d44668))

## [1.1.2](https://github.com/reyemtech/nimbus/compare/v1.1.1...v1.1.2) (2026-02-13)

### Bug Fixes

- Update docs to reflect synchronous factory API ([56b4d01](https://github.com/reyemtech/nimbus/commit/56b4d01d66866933feb5e6a7e5ea4dea21c4270c))

## [1.1.1](https://github.com/reyemtech/nimbus/compare/v1.1.0...v1.1.1) (2026-02-13)

### Bug Fixes

- Use es2020 target in scaffolded tsconfig for Pulumi compatibility ([21f230c](https://github.com/reyemtech/nimbus/commit/21f230c75b876b3cdaf1fcc6646fef9b3ae4dc01))

# [1.1.0](https://github.com/reyemtech/nimbus/compare/v1.0.0...v1.1.0) (2026-02-13)

### Bug Fixes

- Exclude cli/templates from coverage thresholds [skip ci] ([e5a269f](https://github.com/reyemtech/nimbus/commit/e5a269fec93afc746196b768fc4d1900b3650d68))

### Features

- Remove pulumi CLI dependency from `nimbus new` scaffolding ([4e73f8c](https://github.com/reyemtech/nimbus/commit/4e73f8cfecceb9d8fb6d1353a09572b273652de0))
