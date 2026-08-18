// FIRST, for the same reason as main.ts — and this is the entrypoint where it
// matters most: a job that throws here is what #31 calls invisible unless
// someone happens to be reading container logs at the time.
import "./instrument.worker";
// Before the runner and everything it pulls in — see env.worker.ts (#126).
import "./env.worker";
import { consoleLogFactory, Logger } from "graphile-worker";
import { coreEnv, workerEnv } from "./config/env";
import { closeDatabase, createDatabase } from "./db";
import { probeNotifyOrExit } from "./db/notify-probe";
import { drainPool } from "./jobs/connection-pool";
import { startWorker } from "./jobs/runner";
import { startMetricsServer } from "./metrics";

// graphile-worker's own logger, so the lines this file prints are shaped like
// every other line the worker emits — scope label included.
const logger = new Logger(consoleLogFactory, { label: "metrics" });

// Long-running background worker (deployed separately from the HTTP api; see
// jobs/runner.ts for the schedule and for the RUN_WORKER=true embedded mode).
async function main(): Promise<void> {
  // First, because this process's whole promise — an enqueued job starts at once —
  // rests on graphile-worker's `LISTEN "jobs:insert"`, and a transaction-pooled
  // DATABASE_URL accepts that LISTEN and then never delivers on it (#233). Polling
  // would still drag the queue along, so the failure is a slow pipeline nobody can
  // see the cause of. Opens two connections, closes both; worker-once.ts does not
  // run it, because a burst tick never LISTENs.
  await probeNotifyOrExit();
  // Before the runner, so the endpoint is up before the first job can run. This
  // is the worker's only listener and only when METRICS_ENABLED=true: nothing
  // else here speaks HTTP, so without it the job and pipeline counters this
  // process owns could not be scraped at all. Queue depth is read from Postgres
  // by the api, which is always deployed.
  const metrics = await startMetricsServer({
    info: (message) => logger.info(message),
    warn: (message) => logger.warn(message),
  });
  // This process's control-plane pool, created here because this is the process:
  // every task reaches it through the runner rather than through a module-level
  // singleton, so the thing that opens it is also the thing that closes it below.
  const db = createDatabase(coreEnv().DATABASE_URL, workerEnv().PG_POOL_MAX);
  const runner = await startWorker(db);

  // Graceful shutdown: finish in-flight jobs, then drain every pool.
  const stop = async (): Promise<void> => {
    await runner.stop();
    await metrics?.stop();
    await drainPool();
    await closeDatabase(db);
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  await runner.promise;
}

void main();
