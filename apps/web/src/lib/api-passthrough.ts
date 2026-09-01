// The dashboard server answers /api by forwarding it to the api.
//
// This is what makes one origin a property of the APP rather than of the
// deployment. The browser calls /api on whatever origin served the page and the
// session cookie is first-party, whether or not anything is routing /api in
// front of us. Put a reverse proxy in front — the ingress does, compose does —
// and this never runs; the proxy answers first and the hop does not happen.
//
// It is emphatically not the relay that #27 deleted. That was 28 typed wrappers
// re-setting cookies onto another origin, which needed the hand-rolled
// decodeOnce to survive double-encoding. This is one transparent forward: same
// origin in and out, so Set-Cookie passes through byte for byte and there is
// nothing to re-encode.
import { apiOrigin } from "./api-origin";
import { trustsProxy } from "./env";

// Connection-level headers describe THIS hop and must not be forwarded to the
// next one. content-length goes too: the body is re-framed by fetch, and a
// stale length is how a proxy truncates a request.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
]);

// Everything a client could use to claim an address that is not theirs.
//
// This matters more here than it looks. The api's rate limiting is per IP, and
// it reads x-forwarded-for when TRUST_PROXY says something trustworthy sets it.
// Forwarding a browser's own header would let a caller pick a fresh address per
// request and never reach a limit — the exact hole the api's own comment warns
// about. So they are stripped unless this server is itself behind a proxy that
// sets them, which is a thing the deployment has to say out loud.
const CLIENT_SPOOFABLE = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip"];

export function isApiRequest(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

// The headers to send onward. Cookie and Origin are forwarded untouched: the
// cookie is what authenticates, and better-auth checks Origin against its
// trusted origins, so rewriting it would make every auth call look cross-site.
export function forwardedRequestHeaders(incoming: Headers, trusted: boolean): Headers {
  const headers = new Headers();
  incoming.forEach((value, key) => {
    const name = key.toLowerCase();
    if (HOP_BY_HOP.has(name)) return;
    if (!trusted && CLIENT_SPOOFABLE.includes(name)) return;
    headers.set(name, value);
  });
  return headers;
}

// The headers to send back. Set-Cookie is the one that cannot go through the
// generic loop: iterating Headers folds multiple Set-Cookie values into one
// comma-joined string, and a cookie value containing a comma then arrives as
// two broken cookies. getSetCookie keeps them separate.
export function forwardedResponseHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  upstream.forEach((value, key) => {
    const name = key.toLowerCase();
    if (HOP_BY_HOP.has(name) || name === "set-cookie") return;
    headers.set(name, value);
  });
  for (const cookie of upstream.getSetCookie()) headers.append("set-cookie", cookie);
  return headers;
}

// `duplex` is required by undici whenever a request carries a stream body, and
// the DOM's `RequestInit` does not declare it — the spec has it, the lib types
// lag. Declared rather than asserted at the call site: a declaration says what
// is true of the runtime, where the cast only said to stop asking, and this way
// the rest of the init object is still checked.
declare global {
  interface RequestInit {
    duplex?: "half";
  }
}

export async function passThroughToApi(request: Request): Promise<Response> {
  const incoming = new URL(request.url);
  // Built from the pathname rather than by string-joining the raw URL: the
  // pathname is already normalised by the time it reaches here, and it always
  // starts with /api, so there is no way out of the api's origin.
  const target = new URL(`${incoming.pathname}${incoming.search}`, apiOrigin());
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers: forwardedRequestHeaders(request.headers, trustsProxy()),
      // Streamed, not buffered: a buffered proxy would have to be rewritten
      // before SSE could go through it (#22), and it would hold every upload in
      // the dashboard server's memory.
      //
      // Spread, because RequestInit's `body` is `BodyInit` and undefined is not
      // one — a GET carries no body rather than an empty one.
      ...(hasBody ? { body: request.body } : {}),
      duplex: "half",
      redirect: "manual",
    });
  } catch (error) {
    // The api did not answer. 502 rather than a 500 from an unhandled throw,
    // because this server is fine — the one behind it is not, and the reader
    // gets the same "api is unreachable" card the loaders draw.
    console.warn(`api passthrough: ${target.pathname} — ${String(error)}`);
    return Response.json({ message: "the api is unreachable" }, { status: 502 });
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: forwardedResponseHeaders(upstream.headers),
  });
}
