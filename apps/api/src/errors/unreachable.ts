// Is this failure "we could not reach the customer's cluster" rather than a bug
// in our code? Three callers need the same answer: the HTTP layer (502 instead
// of 500), the oRPC handlers (CLUSTER_UNREACHABLE), and the worker (skip the
// tick quietly instead of burning five retries on a database that is down).
//
// The socket-level codes are Node's and apply to every driver; the named errors
// are the Mongo driver's. Other engines add their own names here as they land.
const UNREACHABLE_NAME =
  /MongoServerSelectionError|MongoNetworkError|MongoNetworkTimeoutError|MongoTimeoutError/;
const UNREACHABLE_MESSAGE =
  /getaddrinfo|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|Server selection timed out/i;

export function isUnreachableError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return UNREACHABLE_NAME.test(error.name) || UNREACHABLE_MESSAGE.test(error.message);
}
