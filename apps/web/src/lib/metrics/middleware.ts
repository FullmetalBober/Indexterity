import { createMiddleware } from "@tanstack/react-start";
import { serverFnCalls, serverFnDuration } from "./instruments";

// Per-server-function metrics.
//
// FUNCTION middleware, not request middleware, and that distinction is the whole
// correctness of this file: during SSR a server function is called directly, in
// process, without an HTTP request. A request-level hook therefore sees only the
// calls the browser makes — mutations and client-side navigations — and silently
// misses every loader on a first page load. Function middleware wraps the
// function itself, so both paths are counted.
//
// It also carries the name as written in the source, which the URL does not: a
// server function's path is a sha256 of its file and export name, so `savePolicy`
// would otherwise be labelled `9f2c…`.
//
// Server-only: src/start.ts imports this module behind an import.meta.env.SSR
// check, so vite drops it from the client bundle rather than shipping the
// OpenTelemetry SDK to a browser.
export const serverFnMetricsMiddleware = createMiddleware({ type: "function" }).server(
  async ({ next, serverFnMeta }) => {
    const fn = serverFnMeta.name;
    const started = performance.now();
    try {
      const result = await next();
      // A function that RETURNS is "ok" even when it returns a failure shape:
      // app-server.ts catches and answers with an empty result on purpose, and
      // calling that an error would report the api being down as a dashboard
      // defect. What lands in "error" is the function itself throwing, which is
      // a bug — and the api's own counters are where an api failure is visible.
      serverFnCalls.add(1, { fn, outcome: "ok" });
      return result;
    } catch (error) {
      serverFnCalls.add(1, { fn, outcome: "error" });
      throw error;
    } finally {
      serverFnDuration.record((performance.now() - started) / 1000, { fn });
    }
  },
);
