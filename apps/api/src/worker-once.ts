// FIRST, for the same reason as worker.ts: a tick that throws here is invisible
// unless someone happens to be reading the scheduler's logs.
import "./instrument.worker";
// Before anything that reads configuration — see env.worker.ts (#126).
import "./env.worker";
import { consoleLogFactory, Logger } from "graphile-worker";
import { coreEnv, workerEnv } from "./config/env";
import { closeDatabase, createDatabase } from "./db";
import { runBurstTick } from "./jobs/burst";
import { drainPool } from "./jobs/connection-pool";

const logger = new Logger(consoleLogFactory, { label: "burst" });

// Burst-mode worker: one tick, then exit (#212).
//
// For hosts that sleep. The resident worker (worker.ts) holds a permanent
// LISTEN connection and a cron, both of which need a process that outlives the
// intervals they describe — so on Render free (sleeps after 15 idle minutes) or
// Neon free (suspends compute at 100 CU-hours) the pipeline does not slow down,
// it stops. An external scheduler running THIS on a cron makes that a supported
// topology instead of a broken one:
//
//   RUN_WORKER=false, worker.enabled=false, and something ticking
//   `npm run worker:once` — a GitHub Actions cron, any free cron service, a
//   host's own scheduler.
//
// No metrics listener, deliberately. This process lives for seconds and a
// scrape would have to arrive inside that window; the counters it would export
// are per-process and would read as zero in every scrape that caught one. Queue
// depth is read from postgres by the api, which is where a burst install should
// look instead.
async function main(): Promise<void> {
  const db = createDatabase(coreEnv().DATABASE_URL, workerEnv().PG_POOL_MAX);
  let failed = false;
  try {
    await runBurstTick(db, {
      info: (message) => logger.info(message),
      error: (message) => logger.error(message),
    });
  } catch (error) {
    // A tick that dies must exit NON-ZERO. This is the whole error channel in
    // burst mode: there is no supervisor watching a long-lived process, so a
    // failed run shows up as a red cron job or it shows up nowhere.
    logger.error(`burst tick failed: ${String(error)}`);
    failed = true;
  } finally {
    await drainPool();
    await closeDatabase(db);
  }
  process.exit(failed ? 1 : 0);
}

void main();
