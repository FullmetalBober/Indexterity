import { describe, expect, it } from "vitest";
import { EDGE_HEADERS, withSecurityHeaders } from "./security-headers";

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

  // No Content-Security-Policy yet, and the absence is deliberate rather than
  // forgotten — the document surface needs a script-src the SSR hydration script
  // can live with. This asserts the state so that adding one is a visible change
  // to this test rather than a quiet one.
  it("does not claim a content-security-policy it has not designed", () => {
    expect(withSecurityHeaders(html()).headers.has("content-security-policy")).toBe(false);
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
