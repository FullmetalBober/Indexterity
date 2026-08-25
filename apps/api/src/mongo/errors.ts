import { MongoServerError } from "mongodb";

// The one driver signal that means "these credentials are not allowed to do that
// here", as its own module because two callers ask it for opposite reasons and
// neither is a natural home for the other.
//
// `mongo/provision.ts` asks it about an ADMIN string that cannot create a role,
// and answers with ProvisionDeniedError. `mongo/collector.ts` asks it about a
// per-database read and answers with DatabaseInaccessibleError. Same code from
// the same server, two remedies — so the predicate is shared and the naming of
// what it means stays at each call site.
//
// Measured on 7.0 against a user holding the cluster `listDatabases` action and
// `readWrite` on one database of two: every per-database read of the other one —
// listCollections, listIndexes, $indexStats, collStats — comes back
// `MongoServerError` code 13, codeName `Unauthorized`, "not authorized on other
// to execute command". The message is matched as well as the code because
// Atlas and mongos wrap the same refusal with their own numbering.
export function isAuthorizationError(error: unknown): boolean {
  return (
    error instanceof MongoServerError &&
    (error.code === 13 || /not authorized|requires authentication/i.test(error.message))
  );
}
