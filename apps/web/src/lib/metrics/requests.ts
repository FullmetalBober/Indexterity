import { isApiRequest } from "~/lib/api-passthrough";
import { routeTree } from "~/routeTree.gen";
import { documentDuration, requests } from "./instruments";
import { routeLabeller } from "./routes";

// Wraps the dashboard server's fetch handler. Server-only: src/server.ts is the
// sole importer and vite builds it for the SSR environment alone.

const label = routeLabeller(routeTree);

export type RequestKind = "document" | "asset" | "api";

// Three kinds, because they fail and slow down for different reasons and mixing
// them makes every graph a blend of a page render and a static file.
//
// `api` is worth its own label for a reason beyond tidiness: it counts requests
// the passthrough answered, and the passthrough only runs when nothing in front
// routed /api to the api first. So a non-zero rate here in a deployment that
// has an ingress rule is that rule not working — a hop being paid silently on
// every call, which nothing else would report.
//
// There was a `server_fn` before this one, matched on the /_serverFn prefix. It
// went with the server functions: a series that is always zero reads as "no
// traffic" rather than "no such thing".
//
// Only the build prefix counts as an asset. Guessing from a file extension was
// tempting and wrong: /wp-login.php is not an asset, it is a page request that
// the router will answer with a 404 document, and that is what the handler did.
export function requestKind(pathname: string): RequestKind {
  if (isApiRequest(pathname)) return "api";
  if (pathname.startsWith("/_build")) return "asset";
  return "document";
}

// Count every response, and time the ones whose duration means something. A
// thrown handler is recorded as the 500 the runtime will turn it into — the
// dashboard failing on its own, without the api ever being called, is exactly
// what nothing could see before.
export async function measureRequest(
  request: Request,
  serve: () => Promise<Response> | Response,
): Promise<Response> {
  const pathname = new URL(request.url).pathname;
  const kind = requestKind(pathname);
  const started = performance.now();
  try {
    const response = await serve();
    record(kind, request.method, response.status, pathname, started);
    return response;
  } catch (error) {
    record(kind, request.method, 500, pathname, started);
    throw error;
  }
}

function record(
  kind: RequestKind,
  method: string,
  status: number,
  pathname: string,
  started: number,
): void {
  requests.add(1, { kind, method, status });
  if (kind !== "document") return;
  documentDuration.record((performance.now() - started) / 1000, { route: label(pathname) });
}
