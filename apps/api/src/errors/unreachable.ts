import { messageOf } from "./message";

// Is this failure "we could not reach the CUSTOMER's cluster" rather than a bug
// in our code — or a fault in our own database? Three callers need the same
// answer: the HTTP layer (502 instead of 500), the oRPC handlers
// (CLUSTER_UNREACHABLE), and the worker (skip the tick quietly instead of
// burning five retries on a database that is down).
//
// The question the old version could not answer is WHOSE socket failed (#420).
// It matched Node's socket-level codes anywhere they appeared, and its own
// comment said why that was general: "the socket-level codes are Node's and
// apply to every driver". They apply to the `pg` driver too — the one this
// process talks to its OWN control plane with. Measured on postgres 17: a pool
// whose server goes away mid-pass re-raises a bare `Error` with
// `message: "read ECONNRESET"` from the next query, indistinguishable from a
// customer's database dropping a connection. So a control-plane blip was
// classified as the customer's cluster being unreachable: the cluster was marked
// UNREACHABLE, its owners were mailed about a database answering fine, the false
// alert burned the day's claim, and the postgres fault itself never reached
// Sentry, because a handled skip is recorded as a queue SUCCESS.
//
// The fix is that the ambiguous patterns are only consulted at a boundary that
// KNOWS it is talking to a customer. `asClusterUnreachable` wraps a driver
// failure raised there into the typed error below; everywhere else, only what a
// customer driver alone can produce counts.

/**
 * A transport failure against a customer's cluster, established at the boundary
 * that dialled it rather than guessed at from a message.
 *
 * The original is kept as `cause` AND as this error's own message, because the
 * driver's own words are what an owner reads: "connect ECONNREFUSED
 * 10.0.0.5:27017" names their address and says more than any wording of ours
 * (D112 — it lands in `blocked_detail` and in the alert mail).
 */
export class ClusterUnreachableError extends Error {
  constructor(cause: unknown) {
    super(messageOf(cause));
    this.name = "ClusterUnreachableError";
    this.cause = cause;
  }
}

// What a transport failure looks like from any driver, in the FULL breadth the
// old predicate had — including the codes that are Node's own and say nothing
// about whose socket they came from. Consulted only inside a customer boundary,
// which is what makes the breadth safe again.
//
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
// ESOCKET and "Failed to connect" are tedious's socket-level failures.
const TRANSPORT_MESSAGE =
  /getaddrinfo|querySrv|queryTxt|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMED?OUT|ESOCKET|Failed to connect|Server selection timed out/i;

// Error NAMES only a customer's driver can produce. This process speaks to its
// own database with `pg` and to nothing else with these, so a name here is by
// itself an answer to "whose socket".
//
// ConnectionError is tedious (the SQL Server driver): every dial failure —
// refused, timed out, DNS — arrives under that one name, with the detail in the
// message. ELOGIN (bad credentials) is deliberately NOT unreachable: it surfaces
// as its own error so nobody retries a wrong password five times.
//
// Measured against mongodb 7.0 with the 6.x driver, because this list is what
// carries the mongo path now that the bare Node codes no longer do: a host that
// does not resolve, a refused port, and a server that disappears mid-session all
// arrive as MongoServerSelectionError or MongoNetworkError. One case does not —
// see CUSTOMER_DRIVER_MESSAGE.
const CUSTOMER_DRIVER_NAME =
  /MongoServerSelectionError|MongoNetworkError|MongoNetworkTimeoutError|MongoTimeoutError|^ConnectionError$/;

// Message markers only a customer's driver can produce, for the failures that
// arrive with no useful name.
//
// `querySrv`/`queryTxt` are the load-bearing pair. An SRV lookup that fails
// arrives as a BARE Error — measured: `querySrv ENOTFOUND
// _mongodb._tcp.<host>`, name "Error", nothing else to go on — and an SRV or TXT
// lookup is something only the mongo driver does here. node-pg resolves a
// hostname with `getaddrinfo`, which is why `getaddrinfo` is NOT in this list:
// it is exactly as much our own control plane's failure as a customer's, and it
// is the one that has to come from a boundary.
//
// `Server selection timed out` is mongo's own sentence, and load-bearing since
// the images moved to musl (D76). Measured on both libcs against the same
// resolver: a hostname that does not resolve surfaces as `getaddrinfo EAI_AGAIN
// <host>` on glibc and as a bare `Server selection timed out after Nms` on musl,
// because the driver's own timeout wins the race there. The glibc spelling is
// covered by the boundary; this alternative is what keeps the musl one
// classified, which is exactly the D64 failure mode one libc away.
//
// ESOCKET and "Failed to connect" are tedious's, and tedious talks to nothing
// here but a customer's SQL Server.
const CUSTOMER_DRIVER_MESSAGE =
  /querySrv|queryTxt|ESOCKET|Failed to connect|Server selection timed out/i;

/**
 * The typed answer, from the boundary that knows whose socket it is.
 *
 * Returns what to throw: the wrapped error when this is a transport failure, and
 * the original untouched otherwise — an authorization error, a bad password, a
 * refused TLS posture and a bug in our SQL all pass straight through, which is
 * what keeps them loud.
 *
 * Called as `throw asClusterUnreachable(error)` from a catch inside a customer
 * connection (postgres/connection.ts). A function rather than a wrapper that
 * takes a callback, for the reason ObservedSession is not a Proxy: the place
 * that catches is the place that knows, and it should say so in its own code.
 */
export function asClusterUnreachable(error: unknown): unknown {
  if (error instanceof ClusterUnreachableError) return error;
  if (!(error instanceof Error)) return error;
  if (CUSTOMER_DRIVER_NAME.test(error.name) || TRANSPORT_MESSAGE.test(error.message)) {
    return new ClusterUnreachableError(error);
  }
  return error;
}

export function isUnreachableError(error: unknown): boolean {
  // Established at the boundary. Nothing to guess.
  if (error instanceof ClusterUnreachableError) return true;
  if (!(error instanceof Error)) return false;
  // No boundary said so, so only a driver we use for nothing else can answer.
  // A bare `ECONNRESET` reaching here is our own pool, and it must NOT be
  // classified: it is a fault in our control plane, and its one route to a human
  // is the unhandled-failure path (#420).
  return CUSTOMER_DRIVER_NAME.test(error.name) || CUSTOMER_DRIVER_MESSAGE.test(error.message);
}
