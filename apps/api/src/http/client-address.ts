import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { isIP } from "node:net";

// Believe the client address a trusted proxy puts in ONE header, in place of
// X-Forwarded-For (#574, D180).
//
// Some proxies append to X-Forwarded-For rather than replacing it, and on those
// no TRUST_PROXY value resolves the client — see CLIENT_IP_HEADER in
// config/schema.ts for why neither `true` nor a list of the CDN's ranges does.
// What they do set reliably is a header of their own: Cloudflare's
// `cf-connecting-ip` holds the address that connected to it, and nothing the
// caller sends survives into it.
//
// So the header's address becomes the whole X-Forwarded-For chain, and
// everything downstream is unchanged: Fastify still walks that chain under
// TRUST_PROXY, which still decides whether the PEER that sent the request is
// believed at all. A request from an untrusted peer resolves to the peer, as it
// always did, whatever either header says.
//
// Done on the http server's `request` event, ahead of Fastify, and not in an
// onRequest hook: Fastify reads the address for its "incoming request" log line
// before any hook runs, and that line, both rate limiters and the security trail
// must all name the same client.

/**
 * The headers with X-Forwarded-For replaced by `header`'s single address, or
 * removed when it carries none.
 *
 * Removed rather than kept when the header is missing or is not an address,
 * because keeping it is the forgery this exists to end: the chain left behind
 * is the one the caller wrote the start of. A request with no address resolves
 * to the peer, which is a shared bucket — the right way for an anomaly to fail.
 */
export function believeAddressHeader(headers: IncomingHttpHeaders, header: string): void {
  const value = headers[header];
  const address = typeof value === "string" ? value.trim() : "";
  if (address !== "" && isIP(address) !== 0) {
    headers["x-forwarded-for"] = address;
  } else {
    delete headers["x-forwarded-for"];
  }
}

interface RequestEmitter {
  prependListener(event: "request", listener: (request: IncomingMessage) => void): unknown;
}

/** Rewrite every request `server` receives before anything else sees it. */
export function believeClientAddressHeader(server: RequestEmitter, header: string): void {
  server.prependListener("request", (request) => believeAddressHeader(request.headers, header));
}
