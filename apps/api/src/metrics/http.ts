import type { FastifyInstance, FastifyRequest } from "fastify";
import { httpDuration, httpRequests } from "./instruments";

// The route PATTERN, never the URL. `/api/clusters/:id` is one series; the same
// counter labelled with resolved ids would be one series per cluster, and a
// scanner walking random paths would mint one per request until the scrape
// outgrew the process. Fastify hands us the pattern it matched; anything it did
// not match is a 404 with no route to name, so it is bucketed.
export function routeLabel(request: FastifyRequest): string {
  return request.routeOptions.url ?? "unmatched";
}

// Count and time every response. An onResponse hook rather than a wrapper around
// the handlers: better-auth mounts itself straight on Fastify and oRPC sends its
// own reply, so a hook is the one place that sees all of them.
export function instrumentHttp(fastify: FastifyInstance): void {
  fastify.addHook("onResponse", (request, reply, done) => {
    const route = routeLabel(request);
    httpRequests.add(1, { method: request.method, route, status: reply.statusCode });
    // Fastify measures this in milliseconds; the convention is seconds.
    httpDuration.record(reply.elapsedTime / 1000, { method: request.method, route });
    done();
  });
}
