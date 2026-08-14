# Edge Trust

`verifyEdgeHeaders` is framework-free logic for applications that receive authenticated headers
from a CDN or edge proxy. It fails closed when the shared origin secret is unset or invalid, parses
the client IP from `IP:port` values (including bracketed IPv6), and only returns a client hostname
when it is explicitly allowlisted.

The integration layer decides how to apply the verdict to a framework request. For Laravel, that
means replacing `X-Forwarded-For` and pinning an unrecognised trusted hostname to `app.url`.
