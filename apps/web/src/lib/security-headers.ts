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
//
// `Content-Security-Policy` is the one header deliberately NOT declared there:
// it is per-response (see below), and a second copy arriving from routeRules
// would be INTERSECTED with the real one by every browser — two policies is not
// the stricter of the two, it is neither.
import { randomBytes } from "node:crypto";

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

// ── Content-Security-Policy ─────────────────────────────────────────────────
//
// Not in either list above, because it is the one header here whose value
// changes per response: TanStack Start streams inline scripts — the router's
// dehydrated payload, and the buffered `$tsr` block that carries what resolved
// after the shell — and the only way to allow exactly those without allowing
// every inline script is a nonce minted for the response they belong to. So
// src/server.ts mints one, hands it to the router (`ssr.nonce`, which is what
// puts it on every script the framework emits) and sets the header from the same
// value.
//
// A nonce rather than 'unsafe-inline', which would have been one line: an
// injected `<script>` is the whole class of attack this header exists to stop,
// and 'unsafe-inline' permits precisely that. A nonce rather than hashes,
// because the payload is a tenant's data and is different on every response.

// The nonce's length is the security property: a value an attacker can guess is
// a value they can put on their own script tag. 128 bits, base64, per response
// and never reused — the CSP specification's own floor.
export function newNonce(): string {
  return randomBytes(16).toString("base64");
}

// The style elements this origin writes from JavaScript that cannot be given a
// nonce, allowed by their CONTENT instead.
//
// Two dependencies, and the whole list — measured against the built bundle, not
// assumed:
//
//   sonner              its stylesheet, injected at import time through a
//                       `document.createElement("style")`. Takes no nonce.
//   @radix-ui/react-select  the viewport's scrollbar-hiding rule, rendered as a
//                       React element. It DOES take a `nonce` prop, but the only
//                       way to pass one is through the vendored
//                       components/ui/select.tsx — and forking a registry file
//                       is what the next `shadcn add` undoes.
//
// Everything else that writes a style element asks `get-nonce` for a nonce and
// gets this response's (see ./style-nonce.ts), which is how
// `react-remove-scroll-bar` — whose rule carries the MEASURED scrollbar width and
// so could never be hashed — is covered under every Radix dialog.
//
// The empty-string hash is not a third dependency: a browser checks a style
// element when it is appended and again when its text lands, and the first of
// those checks sees an empty one. It permits nothing but an empty stylesheet.
//
// A hash rather than 'unsafe-inline' because both strings are constants of the
// installed versions — which also makes them checkable. security-headers.test.ts
// recomputes both from node_modules and fails if either has moved, so an upgrade
// is a red unit test naming this constant rather than a toast that quietly loses
// its styling. Regenerate them the way that test does.
const INJECTED_STYLE_HASHES = [
  // sha256 of ""
  "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='",
  // sonner 2.0.7
  "'sha256-CIxDM5jnsGiKqXs2v7NKCY5MzdR9gu6TtiMJrDw29AY='",
  // @radix-ui/react-select's viewport rule
  "'sha256-441zG27rExd4/il+NvIqyL8zFx5XmyNQtE381kSkUJk='",
];

// The policy for a rendered document, given the nonce its scripts carry.
//
// `default-src 'none'` and then the exceptions, rather than a permissive default
// narrowed by exclusions: a directive nobody thought about should refuse rather
// than allow, so the next thing this app fetches from somewhere new fails
// visibly in review instead of quietly widening the policy.
export function documentCsp(nonce: string): string {
  return [
    "default-src 'none'",
    // 'self' covers the built bundle and every `<link rel=modulepreload>` beside
    // it; the nonce covers the inline ones. NOT 'strict-dynamic': it would make
    // browsers ignore 'self', and the modulepreloads carry no nonce of their own
    // because they are links rather than scripts. With `nosniff` sent on every
    // response (above), 'self' cannot be turned into a script by getting the api
    // to echo JSON back at a <script src> — the type has to be right too.
    `script-src 'self' 'nonce-${nonce}'`,
    // No 'unsafe-inline'. Our own CSS is a linked stylesheet — Tailwind through
    // Vite emits one — and every style ELEMENT written from JavaScript is
    // allowed by name instead: by this response's nonce where the library asks
    // for one, and by content hash where it cannot (see above). An injected
    // `<style>` matches neither.
    `style-src 'self' 'nonce-${nonce}' ${INJECTED_STYLE_HASHES.join(" ")}`,
    // The ATTRIBUTE is a separate directive, and the one place 'unsafe-inline'
    // is unavoidable: React server-renders `style={{…}}` as `style="…"`, which
    // is how the virtualized tables position their rows and the charts size
    // their marks. Naming it separately is what keeps `style-src` above strict —
    // and a style attribute cannot carry a selector, so it cannot do the
    // reading that makes injected CSS worth having.
    "style-src-attr 'unsafe-inline'",
    // `data:` for the QR code the two-factor setup draws.
    "img-src 'self' data:",
    "font-src 'self'",
    // The api and the SSE stream are both same-origin: the web server answers
    // /api itself (lib/api-passthrough.ts), which is the whole reason 'self' is
    // enough here. Error reporting is server-side only — @sentry/tanstackstart-react
    // is initialised from lib/errors/provider.ts, which vite builds for the SSR
    // environment alone, so no browser SDK dials an ingest host. Verified in the
    // built client bundle: it contains no Sentry at all.
    "connect-src 'self'",
    "form-action 'self'",
    // The same refusal as `x-frame-options: DENY`, stated in the header that
    // superseded it. Both are sent: the older one is what an old browser reads.
    "frame-ancestors 'none'",
    // Nothing may re-point relative URLs, which is how an injected <base> turns
    // every asset path on the page into someone else's origin.
    "base-uri 'none'",
    "object-src 'none'",
  ].join("; ");
}

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
