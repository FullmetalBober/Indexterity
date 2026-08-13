import type { FastifyInstance } from "fastify";

// The health route, and only it, stops writing a request log.
//
// Fastify logs two lines per request at info — "incoming request" and "request
// completed" — and a kubelet asks this route about nine times a minute per pod
// (readiness every 10s, liveness every 20s). Measured on the built image: 18
// lines a minute at 211 bytes each, which is ~156 MiB per pod-month of a probe
// saying the same thing it said ten seconds ago. Log ingestion is billed by
// volume, and this repo's own house rule — a warning in the log is a defect — only
// works if the log is worth reading.
//
// Silenced per ROUTE rather than by turning request logging off globally, because
// every other line is worth keeping: the api's request log is what the e2e and
// Kind suites read to tell a working deployment from a quiet one.
//
// An `onRoute` hook, not a filter on the way out. Fastify decides whether to log
// from the route's own `logLevel`, so this suppresses the work rather than
// producing the lines and dropping them — and it has to be registered before the
// routes exist, which in main.ts it is (Nest defines them during app.init()).
//
// The failure it is worth knowing about: a route silenced this way logs nothing at
// all, including errors from inside it. That is acceptable here and nowhere else —
// the handler returns a literal and cannot fail. Anything with a body of work
// keeps its log.
export const QUIET_ROUTES: readonly string[] = ["/api/health"];

export function quietProbes(fastify: FastifyInstance): void {
  fastify.addHook("onRoute", (route) => {
    if (QUIET_ROUTES.includes(route.url)) route.logLevel = "silent";
  });
}
