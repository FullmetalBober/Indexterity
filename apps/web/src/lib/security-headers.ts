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
// ── Why this file is imported by vite.config.ts ─────────────────────────────
// There are two ways out of this server and they are not the same code path.
// Nitro serves the built assets and everything in public/ from its own static
// handler, which answers BEFORE the server entry that calls withSecurityHeaders
// below — measured on the built output, where a hashed asset came back with an
// ETag and nothing else, and the first ZAP run reported `nosniff` missing on
// /favicon.svg and /robots.txt for exactly that reason.
//
// `routeRules` in vite.config.ts is the only seam in front of that handler, so
// the headers that must reach EVERY response are declared here and imported
// there, rather than written twice and drifting.

// Sent by both paths: the static handler (through routeRules) and this one.
//
// Nothing here is content-type specific, which is the test for belonging in this
// list rather than the one below.
export const EDGE_HEADERS: Readonly<Record<string, string>> = {
  // Stops a browser guessing a content type. It matters most on the one asset
  // that can be a document — an SVG can carry script, and /favicon.svg was
  // being served without this.
  "x-content-type-options": "nosniff",
  // Features this app does not use. Naming them is what stops an embedded
  // context inheriting the permission from us.
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  // No other origin may read these bytes by embedding them — a <script> or
  // <img> load is a no-cors read that CORS never sees.
  "cross-origin-resource-policy": "same-origin",
  // A page we open, or that opens us, gets no window handle back. Safe here
  // because sign-in is a full redirect: better-auth's GitHub flow navigates,
  // and nothing in this app opens a popup (checked).
  "cross-origin-opener-policy": "same-origin",
};

// Sent on documents and server functions only, because that is the only place
// they mean anything. Both are ignored on a JavaScript response, and a header
// that governs nothing is a header the next reader has to work out.
//
// `Cross-Origin-Embedder-Policy` is deliberately absent, and ZAP reports its
// absence under the same rule id as the two above — see .zap/rules.tsv.
// `require-corp` buys cross-origin isolation, which is for SharedArrayBuffer and
// precise timers, neither of which this app wants; what it costs is that every
// cross-origin subresource must opt in, so the first external avatar or font
// anyone adds breaks silently. There are none today, which makes it free to set
// and worth nothing to have set.
const DOCUMENT_HEADERS: Readonly<Record<string, string>> = {
  // No page here is meant to be framed, and the session cookie is SameSite=Lax
  // — which does travel on a top-level framed navigation. Refusing the frame is
  // what closes the clickjacking half of that.
  "x-frame-options": "DENY",
  // A cluster name or an org id in a URL must not leave in a Referer, and the
  // dashboard does link out (the docs, the wiki, a mailto). `strict-origin` keeps
  // the origin for our own same-origin navigations and sends nothing but the
  // origin cross-site, never the path.
  "referrer-policy": "strict-origin-when-cross-origin",
};

// `Content-Security-Policy` is deliberately NOT in either list yet.
//
// The document surface needs a real `script-src`, and getting one right against
// the SSR output is its own change: TanStack Start streams an inline hydration
// script per response, so a policy without either a per-response nonce or
// 'unsafe-inline' blocks hydration — and a dashboard that renders and then never
// becomes interactive is a worse failure than the one the header prevents,
// because it looks like a slow page. Tracked as #134; the ZAP rule for it is
// IGNOREd in .zap/rules.tsv with the same pointer, so the gate stays honest about
// what it is not yet checking rather than passing quietly.

// Nothing this handler answers may be stored. Every one of them is a document
// rendered from a tenant's data or a server function returning it, and the
// content-hashed assets — the only thing on this origin worth caching — never
// reach here.
//
// It is also what keeps the ROI panel from showing a signed-out user the previous
// tenant's numbers out of the browser's back-forward cache.
const NO_STORE = "no-store, max-age=0";

// A year, and only for the built assets. Vite puts a content hash in every one of
// those filenames, so a changed file is a changed URL and a cached one can never
// be stale. Exported for vite.config.ts, which is where it can reach them.
export const ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

// Add the headers to a response, without touching one that already says
// something: a route that sets its own cache-control has a reason to.
//
// EDGE_HEADERS are repeated here rather than left to routeRules. They overlap,
// harmlessly and on purpose: this function is what `npm run dev` and the unit
// tests exercise, and depending on a nitro config for a header on an SSR response
// would make the two environments disagree about what the app sends.
//
// Called on the ROUTER's responses only, never on the passthrough's. A response
// that came out of `fetch` has an immutable header list and setting one throws —
// and there would be nothing to set anyway, since the api's own onSend hook has
// already answered for everything under /api.
export function withSecurityHeaders(response: Response): Response {
  for (const [name, value] of Object.entries({ ...EDGE_HEADERS, ...DOCUMENT_HEADERS })) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  if (!response.headers.has("cache-control")) response.headers.set("cache-control", NO_STORE);
  return response;
}
