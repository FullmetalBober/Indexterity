import { describe, expect, it } from "vitest";
import { asClusterUnreachable, ClusterUnreachableError, isUnreachableError } from "./unreachable";

function named(name: string, message = "boom"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

// What a customer boundary does with a driver failure: postgres/connection.ts
// catches and rethrows this, and the result is what the worker classifies.
function raisedAgainstACluster(error: Error): unknown {
  return asClusterUnreachable(error);
}

describe("isUnreachableError", () => {
  it("recognizes driver-named connection failures", () => {
    expect(isUnreachableError(named("MongoServerSelectionError"))).toBe(true);
    expect(isUnreachableError(named("MongoNetworkTimeoutError"))).toBe(true);
  });

  // Mongo's own sentence, and the only spelling a hostname that does not resolve
  // gets on musl (D76) — where the driver's timeout wins the race against the
  // resolver. No boundary can be relied on for it: it is what a MONGO dial
  // produces, and those happen in four places.
  it("recognizes mongo's own server-selection sentence, with no boundary", () => {
    expect(isUnreachableError(new Error("Server selection timed out after 5000 ms"))).toBe(true);
  });

  // The heart of #420. These messages are Node's, not a driver's, and this
  // process holds pg pools to BOTH its own control plane and its customers'
  // PostgreSQL clusters — so on their own they answer the wrong question.
  //
  // Measured on postgres 17: a pool whose server goes away re-raises
  // `Error: read ECONNRESET` from the next query, with no name and nothing else
  // to go on. That is what our own database flapping looks like, and classifying
  // it as "the customer's cluster is unreachable" marked their cluster
  // UNREACHABLE, mailed their owners about a database answering fine, burned the
  // 24h alert claim, and suppressed the one signal that OUR postgres had failed
  // (a handled skip is recorded as a queue SUCCESS, so nothing reaches Sentry).
  it("does not classify a bare socket failure that no boundary vouched for", () => {
    expect(isUnreachableError(new Error("read ECONNRESET"))).toBe(false);
    expect(isUnreachableError(new Error("connect ECONNREFUSED 127.0.0.1:5432"))).toBe(false);
    expect(isUnreachableError(new Error("getaddrinfo ENOTFOUND our-neon-host.example"))).toBe(
      false,
    );
    expect(isUnreachableError(new Error("connect ETIMEDOUT 10.0.0.5:5432"))).toBe(false);
  });

  // The same errors, raised where we know whose socket it was. This is the pair
  // that has to hold together: the codes are as broad as they ever were, and the
  // breadth is now scoped to a dial we made on a customer's behalf.
  it("classifies the same failures when a customer boundary raised them", () => {
    for (const message of [
      "read ECONNRESET",
      "connect ECONNREFUSED 10.0.0.5:5432",
      "getaddrinfo ENOTFOUND db.customer.example",
      "connect ETIMEDOUT 10.0.0.5:5432",
      "connect EHOSTUNREACH 10.0.0.5:5432",
      "connect ENETUNREACH 10.0.0.5:5432",
    ]) {
      expect(isUnreachableError(raisedAgainstACluster(new Error(message)))).toBe(true);
    }
  });

  // The SRV path, which is every Atlas cluster: a `mongodb+srv://` string is
  // resolved by dns.resolveSrv before any socket opens, and Node spells a DNS
  // timeout `ETIMEOUT` where a socket timeout is `ETIMEDOUT`. One letter, and it
  // was the difference between "skipped, retrying on the next tick" and five
  // failed attempts with a stack trace each.
  //
  // These are the real messages, taken from a worker that could not resolve.
  it("recognizes a DNS lookup that never answered", () => {
    expect(
      isUnreachableError(new Error("querySrv ETIMEOUT _mongodb._tcp.db.abcde.mongodb.net")),
    ).toBe(true);
    expect(
      isUnreachableError(new Error("querySrv ENOTFOUND _mongodb._tcp.db.abcde.mongodb.net")),
    ).toBe(true);
    // The second lookup an SRV string makes, for the options in the TXT record.
    expect(isUnreachableError(new Error("queryTxt ETIMEOUT db.abcde.mongodb.net"))).toBe(true);
    // And the socket spelling, which is the ambiguous one, still matches through
    // a boundary — see the pair of cases above.
    expect(
      isUnreachableError(raisedAgainstACluster(new Error("connect ETIMEDOUT 10.0.0.5:27017"))),
    ).toBe(true);
  });

  // Why the SRV pair stays in the free-floating list while `getaddrinfo` does
  // not: an SRV or TXT lookup is something only the mongo driver does here, and
  // node-pg resolves a hostname with getaddrinfo. Measured with the 6.x driver —
  // an SRV failure arrives as a BARE Error, name "Error", so nothing but the
  // message can carry it and the four mongo dial sites have no boundary.
  it("keeps the SRV markers classified with no boundary, because only mongo makes them", () => {
    const srv = new Error("querySrv ENOTFOUND _mongodb._tcp.db.abcde.mongodb.net");
    expect(srv.name).toBe("Error");
    expect(isUnreachableError(srv)).toBe(true);
  });

  it("does not swallow ordinary failures", () => {
    // Auth and privilege errors are real, actionable, and must keep failing
    // loudly — retrying them is not going to help.
    expect(isUnreachableError(named("MongoServerError", "Authentication failed"))).toBe(false);
    expect(isUnreachableError(new Error("not authorized on admin to execute command"))).toBe(false);
    expect(isUnreachableError(new Error("cluster not found: abc"))).toBe(false);
    expect(isUnreachableError("ECONNREFUSED")).toBe(false);
    expect(isUnreachableError(undefined)).toBe(false);
  });
});

describe("asClusterUnreachable", () => {
  it("keeps the driver's own message, which is what the owner reads", () => {
    // D112: the message lands in `blocked_detail` and in the alert mail, and the
    // address in it is the reader's own — "connect ECONNREFUSED 10.0.0.5:5432"
    // says more than any wording of ours.
    const wrapped = asClusterUnreachable(new Error("connect ECONNREFUSED 10.0.0.5:5432"));
    expect(wrapped).toBeInstanceOf(ClusterUnreachableError);
    expect(wrapped instanceof Error ? wrapped.message : "").toBe(
      "connect ECONNREFUSED 10.0.0.5:5432",
    );
    expect(wrapped instanceof Error ? wrapped.cause : null).toBeInstanceOf(Error);
  });

  it("hands back everything that is not a transport failure, untouched", () => {
    // A boundary catches every failure inside it, not only the interesting ones:
    // a wrong password, a refused TLS posture and a syntax error in our own SQL
    // all come through, and turning any of them into "cluster unreachable" would
    // skip a tick that should have failed loudly.
    for (const error of [
      new Error('password authentication failed for user "indexterity"'),
      new Error('syntax error at or near "SELCT"'),
      named("InsecureConnectionError", "refusing to connect: this string reaches sslmode=disable"),
      named("PostgresError", "permission denied for table pg_stat_statements"),
    ]) {
      expect(asClusterUnreachable(error)).toBe(error);
      expect(isUnreachableError(error)).toBe(false);
    }
  });

  it("does not double-wrap, and passes a non-Error through", () => {
    const once = asClusterUnreachable(new Error("read ECONNRESET"));
    expect(asClusterUnreachable(once)).toBe(once);
    expect(asClusterUnreachable("ECONNRESET")).toBe("ECONNRESET");
    expect(isUnreachableError("ECONNRESET")).toBe(false);
  });
});
