// FIRST, for the same reason as main.ts — and this is the entrypoint where it
// matters most: a job that throws here is what #31 calls invisible unless
// someone happens to be reading container logs at the time.
import "./instrument.worker";
import { consoleLogFactory, Logger } from "graphile-worker";
import { drainPool } from "./jobs/connection-pool";
import { closeJobDb } from "./jobs/db";
import { startWorker } from "./jobs/runner";
import { startMetricsServer } from "./metrics";

// graphile-worker's own logger, so the lines this file prints are shaped like
// every other line the worker emits — scope label included.
const logger = new Logger(consoleLogFactory, { label: "metrics" });

// Long-running background worker (deployed separately from the HTTP api; see
// jobs/runner.ts for the schedule and for the RUN_WORKER=true embedded mode).
async function main(): Promise<void> {
  // Before the runner, so the endpoint is up before the first job can run. This
  // is the worker's only listener and only when METRICS_ENABLED=true: nothing
  // else here speaks HTTP, so without it the job and pipeline counters this
  // process owns could not be scraped at all. Queue depth is read from Postgres
  // by the api, which is always deployed.
  const metrics = await startMetricsServer({
    info: (message) => logger.info(message),
    warn: (message) => logger.warn(message),
  });
  const runner = await startWorker();

  // Graceful shutdown: finish in-flight jobs, then drain every pool.
  const stop = async (): Promise<void> => {
    await runner.stop();
    await metrics?.stop();
    await drainPool();
    await closeJobDb();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  await runner.promise;
}

void main();
