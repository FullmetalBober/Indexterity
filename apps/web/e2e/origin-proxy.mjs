// One origin for the end-to-end suite: /api to the api, everything else to the
// dashboard. The same rule the ingress applies in production and nginx applies
// in compose, in the smallest thing that can apply it.
//
// It is not a convenience for the tests — it is the thing under test. The
// browser calls the api itself now, and the session cookie only reaches the api
// because both answer on one origin. A suite that started the two servers on two
// ports would be exercising a topology no deployment has.
//
// Started by playwright.config.ts, in front of the two webServer entries.
import { createServer, request as forward } from "node:http";

const PORT = Number(process.env.E2E_ORIGIN_PORT ?? 3212);
const API = new URL(process.env.E2E_API_URL ?? "http://127.0.0.1:3211");
const WEB = new URL(process.env.E2E_WEB_URL ?? "http://127.0.0.1:3210");

const server = createServer((req, res) => {
  const upstream = (req.url ?? "/").startsWith("/api") ? API : WEB;
  // Headers pass through untouched, Origin included: better-auth checks it
  // against its trusted origins, so rewriting it would make every auth request
  // from the suite look cross-site.
  const proxied = forward(
    {
      hostname: upstream.hostname,
      port: upstream.port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );
  // Both upstreams are started by the same playwright run, so this is the window
  // before they are listening. Answering 502 lets playwright's own readiness
  // poll retry instead of the process dying on an unhandled error.
  proxied.on("error", () => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("origin proxy: upstream unreachable");
  });
  req.pipe(proxied);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`origin proxy listening on http://127.0.0.1:${PORT}`);
});
