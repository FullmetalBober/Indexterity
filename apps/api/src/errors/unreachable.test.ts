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
