// First, and a side-effect import rather than a call: ESM evaluates every import
// in this file before the first statement of the body, so an init written as a
// call here would run after everything it is supposed to precede (#31).
import "~/lib/errors/provider";
import { wrapFetchWithSentry } from "@sentry/tanstackstart-react";
import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";
import { isApiRequest, passThroughToApi } from "~/lib/api-passthrough";
import { startMetricsServer } from "~/lib/metrics/provider";
import { measureRequest } from "~/lib/metrics/requests";

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
const fetch = createStartHandler(defaultStreamHandler);

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
const bootState = globalThis as { [BOOTED]?: true };

if (bootState[BOOTED] !== true) {
  bootState[BOOTED] = true;
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
const handleRequest = (request: Request, opts?: unknown): Response | Promise<Response> =>
  measureRequest(request, () =>
    isApiRequest(new URL(request.url).pathname)
      ? passThroughToApi(request)
      : fetch(request, opts as Parameters<typeof fetch>[1]),
  );

export default createServerEntry(wrapFetchWithSentry({ fetch: handleRequest }));
