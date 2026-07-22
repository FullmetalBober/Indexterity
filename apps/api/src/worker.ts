import { run } from "graphile-worker";
import { requiredEnv } from "./env";
import { taskList } from "./jobs/collect";

// Long-running background worker (deploy separately from the HTTP api).
async function main(): Promise<void> {
  const runner = await run({
    connectionString: requiredEnv("DATABASE_URL"),
    concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2),
    taskList,
  });
  await runner.promise;
}

void main();
