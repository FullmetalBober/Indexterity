import { describe, expect, it } from "vitest";
import { isUnreachableError } from "./unreachable";

function named(name: string, message = "boom"): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe("isUnreachableError", () => {
  it("recognizes driver-named connection failures", () => {
    expect(isUnreachableError(named("MongoServerSelectionError"))).toBe(true);
    expect(isUnreachableError(named("MongoNetworkTimeoutError"))).toBe(true);
  });

  it("recognizes socket-level failures from the message", () => {
    expect(isUnreachableError(new Error("connect ECONNREFUSED 127.0.0.1:27017"))).toBe(true);
    expect(isUnreachableError(new Error("getaddrinfo ENOTFOUND db.example.com"))).toBe(true);
    expect(isUnreachableError(new Error("Server selection timed out after 5000 ms"))).toBe(true);
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
    // And the socket spelling still matches, which is the one that already did.
    expect(isUnreachableError(new Error("connect ETIMEDOUT 10.0.0.5:27017"))).toBe(true);
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
