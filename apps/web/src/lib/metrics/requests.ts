import { routeTree } from "~/routeTree.gen";
import { documentDuration, requests } from "./instruments";
import { routeLabeller } from "./routes";

// Wraps the dashboard server's fetch handler. Server-only: src/server.ts is the
// sole importer and vite builds it for the SSR environment alone.

const label = routeLabeller(routeTree);

export type RequestKind = "document" | "asset";

// Two kinds, because they fail and slow down for different reasons and mixing
// them makes every graph a blend of a page render and a static file.
//
// There was a third, `server_fn`, matched on the /_serverFn prefix. There are no
// server functions left — the browser calls the api directly — so it counted
// nothing, and a series that is always zero reads as "no traffic" rather than
// "no such thing". What the dashboard server now serves is documents and the
// files they ask for.
//
// Only the build prefix counts as an asset. Guessing from a file extension was
// tempting and wrong: /wp-login.php is not an asset, it is a page request that
// the router will answer with a 404 document, and that is what the handler did.
export function requestKind(pathname: string): RequestKind {
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
