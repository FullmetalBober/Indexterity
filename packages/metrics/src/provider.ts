import { DiagLogLevel, diag, type Meter, metrics } from "@opentelemetry/api";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

// The OpenTelemetry wiring, shared by every workload that reports anything: the
// api, the worker and the dashboard server. Only the instruments differ.
//
// A factory rather than a module that builds a provider on import, because the
// version has to come from the app — and because the CALLER has to own the
// moment the provider is installed. An OpenTelemetry instrument binds to
// whichever provider was global when it was created, so an instrument built
// before this ran is a no-op forever, with no symptom to notice. Each app
// therefore has a one-line module that calls this, and every instruments module
// imports the meter from there: module initialisation order does the rest.

export interface MetricsOptions {
  // Reported as service.version on target_info. Every package in this repo
  // carries the same version (scripts/set-version.mjs), so any of them will do —
  // the app reads its own because that is the one it can reach at runtime.
  readonly version: string;
  // Reported as service.name. One name for the whole product by default: which
  // workload answered a scrape is the scrape target's business, and they export
  // disjoint instruments anyway.
  readonly serviceName?: string;
  // Prometheus scrape path. Only the default is documented; the option exists
  // because a deployment may already reserve it.
  readonly endpoint?: string;
}

export interface MetricsLog {
  info(message: string): void;
  warn(message: string): void;
}

export interface MetricsServer {
  readonly port: number;
  stop(): Promise<void>;
}

export interface Metrics {
  // Every instrument in the process comes off this one.
  readonly meter: Meter;
  // Starts serving the scrape endpoint, or returns null when metrics are off.
  //
  // Call it before anything that records — accepting a request, starting the job
  // runner — so a scrape cannot arrive before the collectors are registered.
  startMetricsServer(log: MetricsLog): Promise<MetricsServer | null>;
}

// Opt-in. Off means nothing is listening — a local dev run that starts two
// workloads side by side would otherwise fight over the port. Read when the
// endpoint starts rather than at import, so a value that arrives with a .env
// file is already in the environment.
export function metricsEnabled(): boolean {
  return process.env.METRICS_ENABLED === "true";
}

// Separate from the app's own port on purpose: an ingress routes the app port
// and nothing else, so the scrape endpoint stays unreachable from outside the
// cluster until an operator exposes it. It carries no auth. 9464 is the
// registered port for a Prometheus exporter.
export function metricsPort(): number {
  const value = Number(process.env.METRICS_PORT);
  return Number.isFinite(value) && value > 0 ? value : 9464;
}

// One provider per process — which is not the same thing as one per module
// evaluation, and only a dev server tells them apart. Vite re-evaluates the
// whole SSR module graph on a program reload without restarting node, so this
// factory runs again while everything the last run did is still in place: the
// registration below, and the bound port. OpenTelemetry refuses the second
// registration, so the app would carry on with instruments bound to a provider
// whose exporter never got the port, while /metrics answers from the first one
// — numbers that silently stopped moving at the first file save.
//
// The instance therefore hangs off globalThis, where the registry it fights
// with already lives, and Symbol.for is what makes the key survive the module
// being re-evaluated too.
const INSTANCE: unique symbol = Symbol.for("indexterity.metrics.instance");
type InstanceStore = { [INSTANCE]?: Metrics };

export function createMetrics(options: MetricsOptions): Metrics {
  const store = globalThis as InstanceStore;
  const existing = store[INSTANCE];
  if (existing !== undefined) return existing;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: options.serviceName ?? "indexterity",
    [ATTR_SERVICE_VERSION]: options.version,
  });

  const exporter = new PrometheusExporter({
    port: metricsPort(),
    endpoint: options.endpoint ?? "/metrics",
    // The listener starts from startMetricsServer, once it is known whether this
    // deployment wants one.
    preventServerStart: true,
    // There is one instrumentation scope per process, so otel_scope_name would
    // be on every series of every scrape saying nothing.
    withoutScopeInfo: true,
  });

  const provider = new MeterProvider({ resource, readers: [exporter] });
  metrics.setGlobalMeterProvider(provider);

  const instance: Metrics = {
    meter: provider.getMeter("indexterity"),
    startMetricsServer: async (log) => {
      if (!metricsEnabled()) return null;
      // Anything the SDK itself complains about is a defect in how it was wired,
      // so it goes to the process log at its own level — the repo's rule that a
      // warning is a defect only works if warnings are logged as warnings.
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
      log.info(`serving ${options.endpoint ?? "/metrics"} on :${port}`);
      return {
        port,
        // Shuts the reader down, which stops the listener. Prometheus holds the
        // connection open between scrapes, so leaving it to the container
        // runtime would spend the whole grace period on an idle socket.
        stop: () => provider.shutdown(),
      };
    },
  };

  store[INSTANCE] = instance;
  return instance;
}
