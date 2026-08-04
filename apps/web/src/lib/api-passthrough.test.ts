import { describe, expect, it } from "vitest";
import { forwardedRequestHeaders, forwardedResponseHeaders, isApiRequest } from "./api-passthrough";

describe("what the passthrough answers", () => {
  it("takes /api and everything under it", () => {
    expect(isApiRequest("/api")).toBe(true);
    expect(isApiRequest("/api/health")).toBe(true);
    expect(isApiRequest("/api/auth/sign-in/email")).toBe(true);
  });

  // "/apiary" starts with "/api" as a string and is a page. Matching on the
  // prefix alone would send it to the api and 404 a route that exists.
  it("leaves paths that merely start with those letters alone", () => {
    expect(isApiRequest("/apiary")).toBe(false);
    expect(isApiRequest("/app")).toBe(false);
    expect(isApiRequest("/")).toBe(false);
  });
});

describe("headers on the way to the api", () => {
  // The two that authenticate and authorise. The cookie is the session, and
  // better-auth checks Origin against its trusted origins — rewriting either is
  // how a working sign-in turns into a 403.
  it("forwards the cookie and the origin untouched", () => {
    const headers = forwardedRequestHeaders(
      new Headers({ cookie: "better-auth.session_token=abc", origin: "https://app.test" }),
      false,
    );
    expect(headers.get("cookie")).toBe("better-auth.session_token=abc");
    expect(headers.get("origin")).toBe("https://app.test");
  });

  // These describe THIS hop. Passing content-length on is how a proxy truncates
  // a request body that fetch has already re-framed.
  it("drops connection-level headers", () => {
    const headers = forwardedRequestHeaders(
      new Headers({
        "content-type": "application/json",
        connection: "keep-alive",
        "content-length": "42",
        host: "app.test",
      }),
      false,
    );
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("connection")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
    expect(headers.get("host")).toBeNull();
  });

  // The security one. The api rate-limits per IP and reads x-forwarded-for when
  // it is told a proxy sets it. If a browser could send its own, a caller would
  // get a fresh address every request and never reach a limit.
  it("refuses a client's own forwarding headers by default", () => {
    const headers = forwardedRequestHeaders(
      new Headers({
        "x-forwarded-for": "1.2.3.4",
        "x-real-ip": "1.2.3.4",
        "x-forwarded-proto": "https",
        cookie: "s=1",
      }),
      false,
    );
    expect(headers.get("x-forwarded-for")).toBeNull();
    expect(headers.get("x-real-ip")).toBeNull();
    expect(headers.get("x-forwarded-proto")).toBeNull();
    expect(headers.get("cookie")).toBe("s=1");
  });

  // ...and keeps them when the deployment says something trustworthy set them,
  // which is the same switch and the same reasoning as the api's TRUST_PROXY.
  it("forwards them when this server is behind a trusted proxy", () => {
    const headers = forwardedRequestHeaders(new Headers({ "x-forwarded-for": "1.2.3.4" }), true);
    expect(headers.get("x-forwarded-for")).toBe("1.2.3.4");
  });
});

describe("headers on the way back", () => {
  // The one header that cannot go through a generic loop. Iterating Headers
  // folds multiple Set-Cookie values into one comma-joined string, and better-
  // auth's cookies carry commas in their Expires date — so the browser would
  // receive one malformed cookie instead of two good ones, and the session
  // would be the casualty.
  it("keeps each Set-Cookie separate", () => {
    const upstream = new Headers();
    upstream.append("set-cookie", "a=1; Path=/; Expires=Wed, 21 Oct 2026 07:28:00 GMT");
    upstream.append("set-cookie", "b=2; Path=/; HttpOnly");
    const cookies = forwardedResponseHeaders(upstream).getSetCookie();
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toContain("a=1");
    expect(cookies[1]).toContain("b=2");
  });

  it("passes the content type through and drops the hop-by-hop ones", () => {
    const upstream = new Headers({
      "content-type": "application/json",
      "transfer-encoding": "chunked",
    });
    const headers = forwardedResponseHeaders(upstream);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("transfer-encoding")).toBeNull();
  });
});
