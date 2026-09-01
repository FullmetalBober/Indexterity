// First, and a side-effect import rather than a call: ESM evaluates every import
// in this file before the first statement of the body, so an init written as a
// call here would run after everything it is supposed to precede (#31).
import "~/lib/errors/provider";
// Second, and for the same reason: createEnv validates on import, so this is
// where an invalid environment becomes a boot failure that names the variable
// instead of a default that quietly took effect (#126). After the reporter, so
// the refusal is itself reportable.
import "~/lib/env";
import { errorReportingEnabled } from "@repo/errors";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";
import { isApiRequest, passThroughToApi } from "~/lib/api-passthrough";
import { startMetricsServer } from "~/lib/metrics/provider";
import { measureRequest } from "~/lib/metrics/requests";
import { documentCsp, newNonce, withSecurityHeaders } from "~/lib/security-headers";

// The dashboard's server entry. It replaces the framework's default (which is
// exactly the two lines below) for two reasons, both of which need a module that
// only the SSR build contains:
//
//   - the scrape endpoint has to be listening from boot, not from the first
//     request. A listener started lazily means Prometheus reports the target as
//     down until someone visits the site, which is precisely backwards.
//   - every response has to be counted, including the ones the api never hears
//     about: a loader that threw, a 404, a page that rendered slowly.
//   - /api has to be answerable here, so that one origin is a property of the
//     app and not of the deployment (see lib/api-passthrough.ts).
//
// Nothing here reaches the browser: vite resolves this file for the server
// environment alone.
//
// The stream handler is wrapped rather than passed through, for the one header
// that cannot be a constant. A nonce is minted per response, given to the router
// — `ssr.nonce` is what puts it on every script the framework emits, the
// dehydration payload and the buffered `$tsr` block alike — and named in the
// Content-Security-Policy built from the same value. Both halves come from one
// variable on purpose: a header naming a nonce the scripts do not carry is a
// page that renders and never hydrates.
//
// Set HERE rather than in withSecurityHeaders, because this is the only point
// that holds both the router and the response's headers, and it has to happen
// BEFORE the render: the scripts read `ssr.nonce` as they are emitted.
const fetch = createStartHandler((ctx) => {
  const nonce = newNonce();
  ctx.router.update({ ssr: { ...ctx.router.options.ssr, nonce } });
  // `import.meta.env.DEV` rather than NODE_ENV: what needs the allowance is the
  // vite dev server injecting the stylesheet, not a mode anyone can set. Vite
  // replaces it with a literal, so the built output carries no branch at all.
  ctx.responseHeaders.set(
    "content-security-policy",
    documentCsp(nonce, { dev: import.meta.env.DEV }),
  );
  return defaultStreamHandler(ctx);
});

// Off unless METRICS_ENABLED=true. Not awaited, because the entry has to export
// a handler synchronously; a scrape arriving in the millisecond before the port
// is bound is retried by any scraper.
//
// The catch is not decoration. An unhandled rejection ends the process in current
// Node, so without it a port already in use would take the dashboard down — a
// telemetry endpoint that can do that is worse than no telemetry endpoint.
//
// Booted at most once per process rather than once per evaluation of this
// module, because in dev they differ: vite re-evaluates the SSR graph on every
// program reload, and neither the listener nor the signal handlers below belong
// to the module that made them. Unguarded, saving a file binds an already-bound
// port and leaves two more SIGTERM handlers behind.
const BOOTED: unique symbol = Symbol.for("indexterity.web.metrics-booted");
// Reflect rather than asserting a shape onto globalThis — the symbol is
// deliberately not part of its type. Same guard as lib/errors/provider.ts.

if (Reflect.get(globalThis, BOOTED) !== true) {
  Reflect.set(globalThis, BOOTED, true);
  void startMetricsServer({
    info: (message) => console.info(`metrics: ${message}`),
    warn: (message) => console.warn(`metrics: ${message}`),
  })
    .then((server) => {
      if (server === null) return;
      const stop = (): void => void server.stop();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
    })
    .catch((error: unknown) => {
      console.warn(`metrics: endpoint not started — ${String(error)}`);
    });
}

// /api is taken before the router sees it — it owns no such route, so leaving
// it to the router is a 404. Still inside measureRequest, which is how a
// passthrough that is running when a proxy should have answered first becomes
// visible rather than silent.
//
// wrapFetchWithSentry is the outermost layer, so a throw from measureRequest
// itself is still reported. It is the whole of the dashboard's error reporting:
// the docs' other seam, sentryGlobalFunctionMiddleware in a src/start.ts, is
// deliberately not here — D29 built that seam for per-function metrics, measured
// it as restating what the api already reports, and removed it. Reinstating it
// for errors would buy the same little: a server function here is one to three
// api calls, and those already report from the api's own side.
//
// The options argument is typed `unknown` on the way in and cast back on the way
// out, because wrapFetchWithSentry is generic over every framework it supports
// and cannot name TanStack Start's RequestOptions. The value is handed back
// exactly as it arrived — the cast restores a type, it does not assert one.
// withSecurityHeaders wraps the ROUTER branch alone. The api answers /api with
// its own, stricter set (apps/api/src/http/security-headers.ts) and a response
// that arrived through `fetch` has an immutable header list, so adding to it here
// would throw for no gain.
// `opts` is `unknown` because the framework's handler signature says so, and it
// is forwarded to `fetch`, whose second argument is an all-optional object. So
// it is CHECKED for being one rather than asserted to be: anything else was
// never a RequestInit and is dropped instead of handed on as if it were.
const requestInit = (opts: unknown): Parameters<typeof fetch>[1] =>
  typeof opts === "object" && opts !== null ? opts : undefined;

const handleRequest = (request: Request, opts?: unknown): Response | Promise<Response> =>
  measureRequest(request, async () =>
    isApiRequest(new URL(request.url).pathname)
      ? passThroughToApi(request)
      : withSecurityHeaders(await fetch(request, requestInit(opts))),
  );

// The wrapper only when there is something to report to (#176). This was the
// second of the dashboard's two loads of a 17.3 MB SDK, and the one that made
// gating the other pointless: a static `import { wrapFetchWithSentry }` here pulls
// the whole package in whether or not lib/errors/provider ever initialises it.
//
// Unwrapped, the entry is the object the wrapper would have returned anyway —
// `wrapFetchWithSentry` takes a ServerEntry and gives back a ServerEntry — so
// nothing downstream can tell the two apart except by whether a throw gets
// reported, which is the thing being switched off.
const entry = errorReportingEnabled()
  ? (await import("@sentry/tanstackstart-react")).wrapFetchWithSentry({ fetch: handleRequest })
  : { fetch: handleRequest };

export default createServerEntry(entry);
