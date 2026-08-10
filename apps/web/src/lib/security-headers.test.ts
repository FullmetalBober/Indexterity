import { describe, expect, it } from "vitest";
import { documentCsp, EDGE_HEADERS, newNonce, withSecurityHeaders } from "./security-headers";

function html(): Response {
  return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
}

describe("withSecurityHeaders", () => {
  it.each([
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "DENY"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
    ["cross-origin-resource-policy", "same-origin"],
    ["cross-origin-opener-policy", "same-origin"],
  ])("sets %s", (name, value) => {
    expect(withSecurityHeaders(html()).headers.get(name)).toBe(value);
  });

  // The static handler answers assets and public/ before the entry that calls
  // withSecurityHeaders, so these are the ones vite.config.ts has to repeat
  // through routeRules. If one moves out of EDGE_HEADERS it silently stops
  // reaching /favicon.svg, which is how it was missing in the first place.
  it("puts the headers every response needs where nitro can reach them", () => {
    expect(Object.keys(EDGE_HEADERS).sort()).toEqual([
      "cross-origin-opener-policy",
      "cross-origin-resource-policy",
      "permissions-policy",
      "x-content-type-options",
    ]);
  });

  // require-corp buys cross-origin isolation this app does not want and makes
  // the first external avatar anyone adds fail silently.
  it("does not set an embedder policy", () => {
    expect(withSecurityHeaders(html()).headers.has("cross-origin-embedder-policy")).toBe(false);
  });

  it("names the features this app does not use", () => {
    const policy = withSecurityHeaders(html()).headers.get("permissions-policy") ?? "";
    for (const feature of ["camera", "microphone", "geolocation", "payment"]) {
      expect(policy).toContain(`${feature}=()`);
    }
  });

  // The policy is per response and comes from src/server.ts, which is the only
  // place holding both the router the nonce has to reach and the headers it has
  // to be named in. This function must not write a second one over it — two
  // policies on one response are INTERSECTED by the browser, so a constant added
  // here would silently subtract from the real one.
  it("leaves the per-response content-security-policy alone", () => {
    const response = new Response("", {
      headers: { "content-security-policy": "script-src 'nonce-abc'" },
    });
    expect(withSecurityHeaders(response).headers.get("content-security-policy")).toBe(
      "script-src 'nonce-abc'",
    );
  });

  it("writes no content-security-policy of its own", () => {
    expect(withSecurityHeaders(html()).headers.has("content-security-policy")).toBe(false);
  });
});

describe("newNonce", () => {
  // The length is the security property: a nonce an attacker can guess is a
  // nonce they can put on their own script tag.
  it("is 128 bits of base64", () => {
    expect(Buffer.from(newNonce(), "base64")).toHaveLength(16);
  });

  it("is different every time", () => {
    const seen = new Set(Array.from({ length: 64 }, () => newNonce()));
    expect(seen.size).toBe(64);
  });
});

describe("documentCsp", () => {
  const policy = documentCsp("NONCE");
  const directive = (name: string): string =>
    new RegExp(`(?:^|; )${name} ([^;]*)`).exec(policy)?.[1] ?? "";

  it("starts from a default that refuses", () => {
    expect(directive("default-src")).toBe("'none'");
  });

  it("allows the response's own scripts and nothing inline besides", () => {
    expect(directive("script-src")).toBe("'self' 'nonce-NONCE'");
  });

  // 'unsafe-inline' beside a nonce is ignored by a browser that understands the
  // nonce and honoured by one that does not, which makes it a hole shaped like a
  // fallback. 'strict-dynamic' would make 'self' ignored, and the
  // `<link rel=modulepreload>` tags carry no nonce to inherit trust from.
  it.each(["'unsafe-inline'", "'unsafe-eval'", "'strict-dynamic'", "*"])(
    "does not weaken script-src with %s",
    (token) => {
      expect(directive("script-src")).not.toContain(token);
    },
  );

  // The one relaxation, and it is a decision rather than an oversight: `sonner`
  // injects its CSS through a style element at import time with no nonce
  // option, and `react-remove-scroll-bar` writes the measured scrollbar width
  // into a rule, so its content differs between machines and cannot be hashed.
  // Asserted so that narrowing it later is a change to this line rather than a
  // silent one — and so that the same token appearing in script-src, which the
  // case above forbids, stays a separate question.
  it("permits inline styles, and says so only for styles", () => {
    expect(directive("style-src")).toBe("'self' 'unsafe-inline'");
    expect(directive("script-src")).not.toContain("'unsafe-inline'");
  });

  // Same-origin is the whole of it because the web server answers /api itself,
  // and the browser bundle contains no Sentry to dial an ingest host.
  it("keeps every fetch on this origin", () => {
    expect(directive("connect-src")).toBe("'self'");
  });

  it.each([
    ["frame-ancestors", "'none'"],
    ["base-uri", "'none'"],
    ["object-src", "'none'"],
    ["form-action", "'self'"],
    ["font-src", "'self'"],
    ["img-src", "'self' data:"],
  ])("sets %s to %s", (name, value) => {
    expect(directive(name)).toBe(value);
  });

  // Everything this handler answers is a document rendered from a tenant's data
  // or a server function returning it. The content-hashed assets — the only
  // cacheable thing on this origin — are answered by nitro's static handler and
  // get their year from routeRules in vite.config.ts, not from here.
  it("refuses to store what it answers", () => {
    expect(withSecurityHeaders(html()).headers.get("cache-control")).toBe("no-store, max-age=0");
  });

  it("leaves a header the route already set", () => {
    const response = new Response("", { headers: { "referrer-policy": "no-referrer" } });
    expect(withSecurityHeaders(response).headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("leaves a cache-control the route already set", () => {
    const response = new Response("", { headers: { "cache-control": "public, max-age=60" } });
    expect(withSecurityHeaders(response).headers.get("cache-control")).toBe("public, max-age=60");
  });
});
