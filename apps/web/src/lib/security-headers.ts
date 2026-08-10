// The response headers a browser needs in order to refuse things on our behalf.
//
// There were none, on either server — found by asking what #21's ZAP baseline
// scan would report before adding it. The api's own set is in
// apps/api/src/http/security-headers.ts and is stricter, because it serves no
// documents; this is the same idea against the surface that renders in a tab.
//
// Applied here rather than at the ingress on purpose. A header that only exists
// in the chart is a header `npm run dev`, the e2e suite and every self-hoster
// running compose do not have — which means the one place it is exercised is the
// one place nobody tests. The ingress may still add HSTS, which is TLS's business
// and not this process's.
//
// This covers documents and server functions, and NOT the built assets. Nitro
// serves /assets/** from its own static handler, which answers before the server
// entry this module is called from ever runs — measured against the built output,
// where a hashed asset came back with an ETag and nothing else. Those get their
// headers from `routeRules` in vite.config.ts, which is the only seam that sits in
// front of the static handler.

// `Content-Security-Policy` is deliberately NOT here yet.
//
// The document surface needs a real `script-src`, and getting one right against
// the SSR output is its own change: TanStack Start streams an inline hydration
// script per response, so a policy without either a per-response nonce or
// 'unsafe-inline' blocks hydration — and a dashboard that renders and then never
// becomes interactive is a worse failure than the one the header prevents,
// because it looks like a slow page. Tracked as its own issue; the ZAP rule for
// it is IGNOREd in .zap/rules.tsv with the same pointer, so the gate stays honest
// about what it is not yet checking rather than passing quietly.
//
// Everything below is safe on any page this app serves and needs no tuning.
const HEADERS: Readonly<Record<string, string>> = {
  // Stops a browser guessing a content type. The dashboard serves hashed JS and
  // CSS assets and streamed HTML; a sniffed type is only ever wrong.
  "x-content-type-options": "nosniff",
  // No page here is meant to be framed, and the session cookie is SameSite=Lax
  // — which does travel on a top-level framed navigation. Refusing the frame is
  // what closes the clickjacking half of that.
  "x-frame-options": "DENY",
  // A cluster name or an org id in a URL must not leave in a Referer, and the
  // dashboard does link out (the docs, the wiki, a mailto). `strict-origin` keeps
  // the origin for our own same-origin navigations and sends nothing but the
  // origin cross-site, never the path.
  "referrer-policy": "strict-origin-when-cross-origin",
  // Features this app does not use. Naming them is what stops an embedded
  // context inheriting the permission from us.
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
};

// Nothing this handler answers may be stored. Every one of them is a document
// rendered from a tenant's data or a server function returning it, and the
// content-hashed assets — the only thing on this origin worth caching — never
// reach here.
//
// It is also what keeps the ROI panel from showing a signed-out user the previous
// tenant's numbers out of the browser's back-forward cache.
const NO_STORE = "no-store, max-age=0";

// Add the headers to a response, without touching one that already says
// something: a route that sets its own cache-control has a reason to.
//
// Called on the ROUTER's responses only, never on the passthrough's. A response
// that came out of `fetch` has an immutable header list and setting one throws —
// and there would be nothing to set anyway, since the api's own onSend hook has
// already answered for everything under /api.
export function withSecurityHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(HEADERS)) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  if (!response.headers.has("cache-control")) response.headers.set("cache-control", NO_STORE);
  return response;
}
