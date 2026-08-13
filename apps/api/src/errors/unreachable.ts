// Is this failure "we could not reach the customer's cluster" rather than a bug
// in our code? Three callers need the same answer: the HTTP layer (502 instead
// of 500), the oRPC handlers (CLUSTER_UNREACHABLE), and the worker (skip the
// tick quietly instead of burning five retries on a database that is down).
//
// The socket-level codes are Node's and apply to every driver; the named errors
// are the Mongo driver's. Other engines add their own names here as they land.
const UNREACHABLE_NAME =
  /MongoServerSelectionError|MongoNetworkError|MongoNetworkTimeoutError|MongoTimeoutError/;
// `ETIMED?OUT` covers both spellings, and they are two different errors from two
// different parts of Node: a socket that gave up is `ETIMEDOUT`, and a DNS query
// that got no answer is `ETIMEOUT`. Matching only the first missed every
// `mongodb+srv://` cluster — which is every Atlas cluster — because an SRV string
// resolves through `dns.resolveSrv` before a socket is ever opened. The failure
// arrived as `querySrv ETIMEOUT _mongodb._tcp.…`, was classified as a fault in
// our code, and cost five retries at fifty seconds each, a stack trace per
// attempt, a 500 where the dashboard expects CLUSTER_UNREACHABLE, and a Sentry
// report about somebody else's resolver.
//
// `querySrv`/`queryTxt` join `getaddrinfo` for the same reason: those three are
// how a hostname fails to become an address, and which one answers depends only
// on whether the string was SRV.
//
// `Server selection timed out` is load-bearing for a second reason since the
// images moved to musl (D76). Measured on both libcs against the same resolver: a
// hostname that does not resolve surfaces as `getaddrinfo EAI_AGAIN <host>` on
// glibc and as a bare `Server selection timed out after Nms` on musl, because the
// driver's own timeout wins the race there. Both are matched, so the
// classification is identical on both — but only because that alternative is in
// this list, which is exactly the D64 failure mode one libc away.
const UNREACHABLE_MESSAGE =
  /getaddrinfo|querySrv|queryTxt|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMED?OUT|Server selection timed out/i;

export function isUnreachableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return UNREACHABLE_NAME.test(error.name) || UNREACHABLE_MESSAGE.test(error.message);
}
