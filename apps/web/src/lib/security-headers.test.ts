import { describe, expect, it } from "vitest";
import { withSecurityHeaders } from "./security-headers";

function html(): Response {
  return new Response("<!doctype html>", { headers: { "content-type": "text/html" } });
}

describe("withSecurityHeaders", () => {
  it.each([
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "DENY"],
    ["referrer-policy", "strict-origin-when-cross-origin"],
  ])("sets %s", (name, value) => {
    expect(withSecurityHeaders(html()).headers.get(name)).toBe(value);
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
