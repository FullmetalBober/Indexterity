import { readFileSync } from "node:fs";
import { DiagLogLevel, diag, metrics } from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { positiveEnv } from "../env";

// The OpenTelemetry MeterProvider, and the Prometheus endpoint that scrapes it.
//
// Built at import rather than when the endpoint starts, and that is deliberate:
// an OpenTelemetry instrument is bound to whichever provider was installed when
// it was created, so instruments built before this ran would be no-ops forever —
// a trap that costs nothing to avoid and gives no symptom when hit. The cost is
// that measurements aggregate in memory even with the endpoint switched off,
// which is bounded by label cardinality rather than by uptime.
//
// Prometheus is the exporter because that is what the chart ships a
// ServiceMonitor for. Everything above it is the vendor-neutral API, so pointing
// this at an OTLP collector later is a change to this file alone.

// Separate from API_PORT on purpose: the ingress routes the api port and nothing
// else, so the scrape endpoint stays unreachable from outside the cluster until
// an operator exposes it. It carries no auth. 9464 is the registered port for a
// Prometheus exporter.
export function metricsPort(): number {
  return positiveEnv("METRICS_PORT", 9464);
}

// Opt-in. Off means nothing is listening — a local `npm run dev` that starts the
// api and the worker side by side would otherwise fight over the port. Read when
// the endpoint starts, not at import, so a value from @nestjs/config's .env is
// already in the environment.
export function metricsEnabled(): boolean {
  return process.env.METRICS_ENABLED === "true";
}

// swc mirrors src/ into dist/, so ../../package.json is apps/api/package.json
// from both. Reported as service.version on target_info.
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

// One service name for both workloads. Which of them answered a scrape is the
// scrape target's business — the ServiceMonitor labels every series with the
// Service and pod it came from — and the two export disjoint metric sets anyway.
const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: "indexterity",
  [ATTR_SERVICE_VERSION]: appVersion(),
});

const exporter = new PrometheusExporter({
  port: metricsPort(),
  // The listener starts from startMetricsServer, once it is known whether this
  // deployment wants one.
  preventServerStart: true,
  // There is one instrumentation scope, so otel_scope_name="indexterity" would
  // be on every series of every scrape saying nothing.
  withoutScopeInfo: true,
});

const provider = new MeterProvider({ resource, readers: [exporter] });
metrics.setGlobalMeterProvider(provider);

export const meter = provider.getMeter("indexterity");

export interface MetricsServer {
  readonly port: number;
  stop(): Promise<void>;
}

export interface MetricsLog {
  info(message: string): void;
  warn(message: string): void;
}

// Start serving GET /metrics on the metrics port. Returns null when metrics are
// off, which is the default.
//
// Call this before anything that records — starting the job runner, accepting a
// request — so a scrape cannot arrive before the collectors are registered.
export async function startMetricsServer(log: MetricsLog): Promise<MetricsServer | null> {
  if (!metricsEnabled()) return null;
  // Anything the SDK itself complains about is a defect in how it was wired
  // here, so it goes to the process log at its own level — §16 makes a warning
  // a defect, which only works if warnings are logged as warnings.
  diag.setLogger(
    {
      verbose: () => {},
      debug: () => {},
      info: () => {},
      warn: (message) => log.warn(`opentelemetry: ${message}`),
      error: (message) => log.warn(`opentelemetry: ${message}`),
    },
    DiagLogLevel.WARN,
  );
  await exporter.startServer();
  const port = metricsPort();
  log.info(`serving /metrics on :${port}`);
  return {
    port,
    // Shuts the reader down, which stops the listener. Prometheus holds the
    // connection open between scrapes, so leaving it to the container runtime
    // would spend the whole grace period on an idle socket.
    stop: () => provider.shutdown(),
  };
}
