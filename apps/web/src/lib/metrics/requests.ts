import { routeTree } from "~/routeTree.gen";
import { documentDuration, requests } from "./instruments";
import { routeLabeller } from "./routes";

// Wraps the dashboard server's fetch handler. Server-only: src/server.ts is the
// sole importer and vite builds it for the SSR environment alone.

const label = routeLabeller(routeTree);

// Server function calls arrive under this prefix. Read from the build rather than
// written down, because it is configurable (serverFns.base) and a hard-coded copy
// would silently misclassify every call if it were ever changed.
function serverFnBase(): string {
  const configured: unknown = import.meta.env.TSS_SERVER_FN_BASE;
  return typeof configured === "string" && configured.length > 0 ? configured : "/_serverFn";
}

const SERVER_FN_BASE = serverFnBase();

export type RequestKind = "document" | "server_fn" | "asset";

// Three kinds, because they fail and slow down for different reasons and mixing
// them makes every graph a blend of a page render and a static file.
//
// Only the build prefix counts as an asset. Guessing from a file extension was
// tempting and wrong: /wp-login.php is not an asset, it is a page request that
// the router will answer with a 404 document, and that is what the handler did.
export function requestKind(pathname: string): RequestKind {
  if (pathname.startsWith(SERVER_FN_BASE)) return "server_fn";
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
