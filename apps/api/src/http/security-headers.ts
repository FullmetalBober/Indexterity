import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

// The response headers a browser needs in order to refuse things on our behalf.
//
// There were none, on either server — found by asking what #21's ZAP baseline
// scan would report before adding it, since a scan that can fail is unaddable
// until this exists. Hand-rolled rather than @fastify/helmet: helmet's value is the
// twelve headers you have not thought about, and every one of them here is a
// decision about a specific surface. This api serves JSON, SSE and nothing a
// browser will ever render as a document, which makes its correct policy far
// stricter than any default — and lets it be stated in one screen.
//
// The dashboard's own headers are the same idea against a different surface, and
// live in apps/web/src/lib/security-headers.ts. Both are needed: production puts
// one origin in front of both servers, so a request to /api is answered by this
// process without the dashboard's handler ever running.

// Applied to every response, whatever it is.
//
// `Content-Security-Policy: default-src 'none'` is the strongest statement
// available and it is *true here*: nothing this api returns loads a subresource,
// because nothing it returns is a document. `frame-ancestors 'none'` is the part
// that does work even so — a JSON endpoint framed by an attacker's page is how a
// same-site cookie ends up on a request the user did not make — and it is the
// modern spelling of X-Frame-Options, which is sent as well for the browsers and
// scanners that still read only that one.
//
// Two headers deliberately absent:
//
//   Strict-Transport-Security is set by whatever terminates TLS, not here. This
//   process is reached over plain HTTP inside the cluster and by the e2e suite on
//   127.0.0.1, and an HSTS header from an http:// origin is ignored by browsers
//   anyway — sending one would be a header that looks like a policy and is not.
//   The chart's ingress is where it belongs (see deploy/helm).
//
//   Cross-Origin-Resource-Policy: same-origin would break nothing today and say
//   nothing either: every reader of this api is same-origin already, by the
//   design that lets the browser hold the session cookie at all.
const HEADERS: Readonly<Record<string, string>> = {
  // No subresources, no framing, no plugins, no <base> tricks. Everything this
  // api can legitimately do is already permitted by returning bytes.
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
  // The one header that stops a browser from guessing that our JSON is HTML.
  // Without it, an endpoint that echoes a user-controlled string can be coaxed
  // into being sniffed as a document and executed on our origin.
  "x-content-type-options": "nosniff",
  // The same refusal as frame-ancestors, for readers that predate CSP 2.
  "x-frame-options": "DENY",
  // A cluster id or a recommendation id in a Referer to a third party is a
  // customer's topology leaking through a click. Nothing here links out, so
  // there is no referrer worth sending at all.
  "referrer-policy": "no-referrer",
  // None of these features exist in a JSON response; saying so is what stops an
  // embedded context from inheriting the permission.
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

// A browser must not reuse an authenticated answer for the next caller, and a
// proxy must not keep one at all. Applied to everything except the endpoints
// where a cache is the point — none exist yet, which is why this is not
// conditional: an api that grows a public, cacheable route can say so there.
//
// This is also what keeps the ROI panel from showing a signed-out user the
// previous tenant's numbers from the browser's back-forward cache.
const NO_STORE = "no-store, max-age=0";

export function securityHeaders(fastify: FastifyInstance): void {
  // onSend rather than onRequest: a route that sets its own value wins, because
  // by here the route has already run. Nothing overrides these today, and the
  // ordering is what makes it possible to.
  fastify.addHook("onSend", (_request: FastifyRequest, reply: FastifyReply, payload, done) => {
    for (const [name, value] of Object.entries(HEADERS)) {
      if (reply.getHeader(name) === undefined) reply.header(name, value);
    }
    if (reply.getHeader("cache-control") === undefined) reply.header("cache-control", NO_STORE);
    // Defensive rather than corrective: neither Fastify nor the Nest adapter
    // sets this (checked — Express does, and this api is not on Express). A
    // plugin or a proxy that starts naming the framework and its version is free
    // reconnaissance, and the cost of never having to notice is one line.
    reply.removeHeader("x-powered-by");
    done(null, payload);
  });
}
