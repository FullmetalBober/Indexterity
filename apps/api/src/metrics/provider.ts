import { readFileSync } from "node:fs";
import { createMetrics } from "@repo/metrics";

// The api's (and the worker's) meter. The OpenTelemetry wiring lives in
// @repo/metrics; this module exists so that it is installed HERE, before
// instruments.ts is evaluated — an instrument binds to whichever provider was
// global when it was created, and one built too early is a no-op forever.

// swc mirrors src/ into dist/, so ../../package.json is apps/api/package.json
// from both.
function appVersion(): string {
  try {
    const raw: unknown = JSON.parse(readFileSync(`${__dirname}/../../package.json`, "utf8"));
    if (typeof raw === "object" && raw !== null) {
      const version: unknown = Reflect.get(raw, "version");
      if (typeof version === "string") return version;
    }
  } catch {
    // Not fatal: an unknown version is worth less than a crashed process.
  }
  return "unknown";
}

export const { meter, startMetricsServer } = createMetrics({ version: appVersion() });
export type { MetricsLog, MetricsServer } from "@repo/metrics";
export { metricsEnabled, metricsPort } from "@repo/metrics";
