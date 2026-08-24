import type { IncomingHttpHeaders } from "node:http";

// Fastify's parsed headers -> a web Headers, so better-auth can read the session
// cookie from a Nest/Fastify request.
export function toWebHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
  }
  return headers;
}

// The headers better-auth's handler is given, which is the pair above plus the
// one thing a synthetic Request cannot carry: who is asking.
//
// better-auth resolves the client address from headers ALONE — there is no socket
// under the Request main.ts builds for it — and its own chain-walking wants the
// CIDR ranges of every hop in front. Fastify has already answered that exact
// question, through proxy-addr, in whichever dialect TRUST_PROXY is written in
// (`true`, a hop count, or a range list). So the resolved address is handed over
// as a one-entry chain and both limiters agree by construction rather than by two
// configurations being kept in step.
//
// Two failures this closes, one in each posture (#54 left both open):
//
//   BEHIND A PROXY, better-auth believes X-Forwarded-For only when it carries
//   exactly one address unless it is told which hops to distrust — and a managed
//   host (Render, Fly, anything behind Cloudflare) adds a hop whose address it
//   does not publish, so no range list can be written. Every caller resolved to
//   "no ip" and shared ONE bucket: "Rate limiting could not determine a client IP
//   and is falling back to a single shared per-path bucket", observed in
//   production.
//
//   DIRECTLY EXPOSED, better-auth reads x-forwarded-for BY DEFAULT, and one
//   address is exactly what it believes — so a client could send a fresh
//   `X-Forwarded-For: 1.2.3.4` per attempt and never reach the sign-in limit,
//   which is the hole TRUST_PROXY being off by default exists to avoid.
//
// Overwriting rather than appending is what closes the second: whatever arrived
// under this name is gone by the time better-auth reads it. When Fastify has no
// address at all the header goes out empty, which better-auth reads as unresolved
// — the shared bucket again, and the right way to fail.
export function authRequestHeaders(raw: IncomingHttpHeaders, clientIp: string): Headers {
  const headers = toWebHeaders(raw);
  headers.set("x-forwarded-for", clientIp);
  return headers;
}
