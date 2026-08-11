import { join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { makeWorkerUtils } from "graphile-worker";
import { coreEnv, loadEnvOrExit } from "./config/env";
import { closeDatabase, createDatabase } from "./db";

// Production migration entrypoint: `node dist/migrate.js`. drizzle-kit is a
// devDependency and is pruned from the runtime image, so deployments (the Helm
// pre-upgrade hook) run the drizzle-orm migrator against the same SQL folder
// instead. Idempotent — already-applied migrations are skipped.
//
// Two schemas, because the database has two owners. Drizzle owns `public`;
// graphile-worker owns its own, and installs it the first time a worker boots.
// That left a race nobody had reason to notice: the api and the worker start
// together, and until the worker wins, every endpoint that queues a job — the
// collect button, every manual tick — fails, because addJob writes to a schema
// that is not there yet. Locally it never shows, since the worker has been up
// against the same database for months.
//
// Migration is where schemas get created, so both are created here. Keep this
// in step with the db:migrate script, which does the same for dev and CI.
// The Helm pre-install hook gives this Job DATABASE_URL and nothing else, so it
// validates the narrowest of the three schemas.
async function main(): Promise<void> {
  loadEnvOrExit("migrate");
  const db = createDatabase(coreEnv().DATABASE_URL);
  try {
    await migrate(db, { migrationsFolder: join(__dirname, "..", "drizzle") });
    const utils = await makeWorkerUtils({ connectionString: coreEnv().DATABASE_URL });
    try {
      await utils.migrate();
    } finally {
      await utils.release();
    }
    console.log("migrations applied");
  } finally {
    await closeDatabase(db);
  }
}

main().catch((error: unknown) => {
  console.error("migration failed:", error);
  process.exit(1);
});
