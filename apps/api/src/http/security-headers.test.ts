import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";
import { securityHeaders } from "./security-headers";

// A reply with just the four methods the hook uses. Cheaper than a Fastify
// instance and it makes the assertions about the headers rather than about
// whether a server started.
function replyWith(initial: Record<string, string> = {}) {
  const headers = new Map(Object.entries(initial));
  return {
    headers,
    getHeader: (name: string) => headers.get(name),
    header: (name: string, value: string) => headers.set(name, value),
    removeHeader: (name: string) => headers.delete(name),
  };
}

// Register the hook, then run it the way Fastify would.
function send(initial?: Record<string, string>): Map<string, string> {
  let hook: ((...args: unknown[]) => void) | null = null;
  const fastify = {
    addHook: (_event: string, handler: (...args: unknown[]) => void) => {
      hook = handler;
    },
  } as unknown as FastifyInstance;
  securityHeaders(fastify);
  if (hook === null) throw new Error("the hook was never registered");
  const reply = replyWith(initial);
  (hook as (...args: unknown[]) => void)(
    {} as FastifyRequest,
    reply as unknown as FastifyReply,
    "payload",
    () => {},
  );
  return reply.headers;
}

describe("securityHeaders", () => {
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
