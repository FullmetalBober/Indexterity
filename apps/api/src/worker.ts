import { drainPool } from "./jobs/connection-pool";
import { closeJobDb } from "./jobs/db";
import { startWorker } from "./jobs/runner";

// Long-running background worker (deployed separately from the HTTP api; see
// jobs/runner.ts for the schedule and for the RUN_WORKER=true embedded mode).
async function main(): Promise<void> {
  const runner = await startWorker();

  // Graceful shutdown: finish in-flight jobs, then drain every pool.
  const stop = async (): Promise<void> => {
    await runner.stop();
    await drainPool();
    await closeJobDb();
    process.exit(0);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());
  await runner.promise;
}

void main();
