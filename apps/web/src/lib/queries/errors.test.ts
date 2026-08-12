import { ORPCError } from "@orpc/client";
import { describe, expect, it } from "vitest";
import { AuthApiError, apiMessage, isSessionStale, isTwoFactorRequired } from "./errors";

const FALLBACK = "failed to connect cluster";

describe("apiMessage", () => {
  it("shows the api's words for a status written for the reader", () => {
    const refused = new ORPCError("BAD_REQUEST", {
      status: 400,
      message: "connection string must be mongodb:// or mongodb+srv://",
    });
    expect(apiMessage(refused, FALLBACK)).toBe(
      "connection string must be mongodb:// or mongodb+srv://",
    );
  });

  it("keeps a 500 generic", () => {
    const internal = new ORPCError("INTERNAL_SERVER_ERROR", {
      status: 500,
      message: "column recommendations.foo does not exist",
    });
    expect(apiMessage(internal, FALLBACK)).toBe(FALLBACK);
  });

  it("honours a narrowed list over the default one", () => {
    const forbidden = new ORPCError("FORBIDDEN", { status: 403, message: "owner role required" });
    expect(apiMessage(forbidden, FALLBACK, [400, 502])).toBe(FALLBACK);
  });

  // #162. The dial budget answers 429, which is not readable by default, and
  // every route that can raise it narrows the list to its own failures — so
  // without the code rule the reader gets "failed to connect cluster" for a
  // refusal that already says exactly what happened.
  it("shows the dial budget's own words through a narrowed list", () => {
    const spent = new ORPCError("DIAL_BUDGET", {
      status: 429,
      message: "connection attempts are limited to 10 every 60s per account — try again in 41s",
    });
    expect(apiMessage(spent, FALLBACK, [400, 422, 502])).toBe(
      "connection attempts are limited to 10 every 60s per account — try again in 41s",
    );
  });

  // The other 429 in this product is better-auth's per-address rate limit, and it
  // stays generic: the code is what earns the exemption, not the status.
  it("keeps an unnamed 429 generic", () => {
    const throttled = new ORPCError("TOO_MANY_REQUESTS", { status: 429, message: "slow down" });
    expect(apiMessage(throttled, FALLBACK)).toBe(FALLBACK);
  });

  it("falls back for something that is not an error at all", () => {
    expect(apiMessage("nope", FALLBACK)).toBe(FALLBACK);
    expect(apiMessage(undefined, FALLBACK)).toBe(FALLBACK);
  });
});

describe("the codes the dashboard branches on", () => {
  it("recognizes a stale session", () => {
    const stale = new ORPCError("SESSION_NOT_FRESH", { status: 403, message: "confirm password" });
    expect(isSessionStale(stale)).toBe(true);
    expect(isSessionStale(new ORPCError("FORBIDDEN", { status: 403 }))).toBe(false);
  });

  // Raised by the api on its own routes and by better-auth's plugin on the org
  // ones, and reported identically either way.
  it("recognizes a missing second factor from both sources", () => {
    expect(isTwoFactorRequired(new ORPCError("TWO_FACTOR_REQUIRED", { status: 403 }))).toBe(true);
    expect(isTwoFactorRequired(new AuthApiError("enrol first", 403, "TWO_FACTOR_REQUIRED"))).toBe(
      true,
    );
  });
});
