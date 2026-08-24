import { describe, expect, it } from "vitest";
import { authRequestHeaders, toWebHeaders } from "./http";

describe("toWebHeaders", () => {
  it("carries a repeated header over as repeats rather than the last one", () => {
    const headers = toWebHeaders({ "set-cookie": ["a=1", "b=2"], host: "api.example.com" });
    expect(headers.getSetCookie()).toEqual(["a=1", "b=2"]);
    expect(headers.get("host")).toBe("api.example.com");
  });
});

// The whole point of the function: better-auth reads the client address out of
// these headers and rate-limits sign-ins by it, so what it finds under
// x-forwarded-for has to be this deployment's answer and not the caller's.
describe("authRequestHeaders", () => {
  it("replaces the forwarded chain with the one address Fastify resolved", () => {
    const headers = authRequestHeaders(
      { "x-forwarded-for": "203.0.113.9, 10.0.0.5", cookie: "session=x" },
      "203.0.113.9",
    );
    expect(headers.get("x-forwarded-for")).toBe("203.0.113.9");
    expect(headers.get("cookie")).toBe("session=x");
  });

  // Directly exposed, Fastify hands back the socket address and the header the
  // client wrote is gone — otherwise better-auth believes it, because a
  // single-address chain is exactly the shape it trusts, and a fresh forged
  // address per attempt is a sign-in limit that never fires.
  it("discards an address the caller invented", () => {
    const headers = authRequestHeaders({ "x-forwarded-for": "1.2.3.4" }, "198.51.100.7");
    expect(headers.get("x-forwarded-for")).toBe("198.51.100.7");
  });

  it("adds the header when the request arrived without one", () => {
    expect(authRequestHeaders({}, "198.51.100.7").get("x-forwarded-for")).toBe("198.51.100.7");
  });

  // No address is a real answer: better-auth reads an empty chain as unresolved
  // and falls back to its shared bucket, which is the safe direction. What must
  // not happen is the caller's value surviving because ours was empty.
  it("leaves nothing behind when there is no address to hand over", () => {
    expect(authRequestHeaders({ "x-forwarded-for": "1.2.3.4" }, "").get("x-forwarded-for")).toBe(
      "",
    );
  });
});
