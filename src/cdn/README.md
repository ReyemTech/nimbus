# CDN

`createCdn` provisions the trusted CloudFront edge used by applications that opt into the
edge-trust middleware. Each configured hostname receives its own distribution because the
authenticated client-host header is static per CloudFront origin.

The origin request policy excludes `Host` while forwarding all viewer headers, including the
CloudFront viewer-address and geo headers. Each origin request includes the configured origin
secret and the configured client-host header. `hostedZoneId` creates both Route 53 `A` and `AAAA`
aliases for every distribution; the cluster-managed origin DNS remains out of scope.
