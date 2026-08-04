import { createMetrics } from "@repo/metrics";
import pkg from "../../../package.json" with { type: "json" };

// The dashboard server's meter. Same reason for existing as the api's copy: the
// OpenTelemetry provider has to be installed before any instrument is created,
// and module initialisation order is what guarantees that — instruments.ts
// imports the meter from here.
//
// Server-only. Nothing in this directory may be imported from a route or a
// component: the only entry point is src/server.ts, which vite builds for the
// SSR environment alone, so none of it reaches the browser bundle.
export const { meter, startMetricsServer } = createMetrics({ version: pkg.version });
