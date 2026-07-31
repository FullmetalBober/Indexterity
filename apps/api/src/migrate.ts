import { join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDatabase, createDatabase } from "./db";
import { requiredEnv } from "./env";

// Production migration entrypoint: `node dist/migrate.js`. drizzle-kit is a
// devDependency and is pruned from the runtime image, so deployments (the Helm
// pre-upgrade hook) run the drizzle-orm migrator against the same SQL folder
// instead. Idempotent — already-applied migrations are skipped.
async function main(): Promise<void> {
  const db = createDatabase(requiredEnv("DATABASE_URL"));
  try {
    await migrate(db, { migrationsFolder: join(__dirname, "..", "drizzle") });
    console.log("migrations applied");
  } finally {
    await closeDatabase(db);
  }
}

main().catch((error: unknown) => {
  console.error("migration failed:", error);
  process.exit(1);
});
