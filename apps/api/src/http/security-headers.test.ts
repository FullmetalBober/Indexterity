import { describe, expect, it } from "vitest";
import { applySecurityHeaders } from "./security-headers";

// A complete HeaderSink, and nothing else.
//
// This used to register the hook into a fake FastifyInstance, capture the
// handler, and invoke it with a fake FastifyRequest and a stubbed FastifyReply —
// three vendor fakes to reach a rule about which headers get set. The rule is
// its own function now, so the test calls it.
//
// What was lost by not going through the hook is `onSend` ordering, which is a
// Fastify fact rather than ours, and the e2e suite asserts these headers on real
// responses (csp.spec.ts).
function send(initial: Record<string, string> = {}): Map<string, string> {
  const headers = new Map(Object.entries(initial));
  applySecurityHeaders({
    getHeader: (name) => headers.get(name),
    header: (name, value) => headers.set(name, value),
    removeHeader: (name) => headers.delete(name),
  });
  return headers;
}

describe("applySecurityHeaders", () => {
  it.each([
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "DENY"],
    ["referrer-policy", "no-referrer"],
    ["cross-origin-resource-policy", "same-origin"],
  ])("sets %s", (name, value) => {
    expect(send().get(name)).toBe(value);
  });

  // This api serves no documents, so the strongest policy available is also the
  // true one. frame-ancestors is the directive doing real work: a JSON endpoint
  // framed by an attacker's page is how a SameSite cookie rides along.
  it("refuses everything in its content-security-policy", () => {
    const policy = send().get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("base-uri 'none'");
  });

  it("does not let an authenticated answer be stored", () => {
    expect(send().get("cache-control")).toBe("no-store, max-age=0");
  });

  // Nothing sets this today — Fastify does not, and neither does the Nest
  // adapter. The hook is what makes a plugin or a proxy that starts naming the
  // framework something nobody has to catch.
  it("strips the framework's version banner", () => {
    expect(send({ "x-powered-by": "Fastify" }).has("x-powered-by")).toBe(false);
  });

  it.each(["cache-control", "content-security-policy", "referrer-policy"])(
    "leaves a %s the route set for itself",
    (name) => {
      expect(send({ [name]: "already-decided" }).get(name)).toBe("already-decided");
    },
  );

  // Strict-Transport-Security belongs to whatever terminates TLS. Sent from a
  // process reached over plain http inside the cluster it is ignored by every
  // browser, which makes it a header that looks like a policy and is not.
  it("leaves HSTS to the thing that terminates TLS", () => {
    expect(send().has("strict-transport-security")).toBe(false);
  });
});
