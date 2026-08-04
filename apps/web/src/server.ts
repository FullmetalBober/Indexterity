import { createStartHandler, defaultStreamHandler } from "@tanstack/react-start/server";
import { createServerEntry } from "@tanstack/react-start/server-entry";
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
//
// Nothing here reaches the browser: vite resolves this file for the server
// environment alone.
const fetch = createStartHandler(defaultStreamHandler);

// Off unless METRICS_ENABLED=true. The promise is not awaited because the entry
// must export a handler synchronously; a scrape that arrives in the millisecond
// before the port is bound is retried by any scraper.
void startMetricsServer({
  info: (message) => console.info(`metrics: ${message}`),
  warn: (message) => console.warn(`metrics: ${message}`),
}).then((server) => {
  if (server === null) return;
  const stop = (): void => void server.stop();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
});

export default createServerEntry({
  fetch: (request, ...rest) => measureRequest(request, () => fetch(request, ...rest)),
});
