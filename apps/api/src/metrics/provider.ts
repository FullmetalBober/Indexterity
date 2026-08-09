import { createMetrics } from "@repo/metrics";
import { APP_VERSION } from "../version";

// The api's (and the worker's) meter. The OpenTelemetry wiring lives in
// @repo/metrics; this module exists so that it is installed HERE, before
// instruments.ts is evaluated — an instrument binds to whichever provider was
// global when it was created, and one built too early is a no-op forever.

export const { meter, startMetricsServer } = createMetrics({ version: APP_VERSION });
export type { MetricsLog, MetricsServer } from "@repo/metrics";
export { metricsEnabled, metricsPort } from "@repo/metrics";
