import {
  actions,
  and,
  clusters,
  createDatabase,
  type Database,
  desc,
  eq,
  policies,
  recommendations,
} from "@repo/db";
import { makeWorkerUtils, runOnce } from "graphile-worker";
import { requiredEnv } from "./env";
import { taskList } from "./jobs/tasks";

async function stateCounts(db: Database, clusterId: string): Promise<Record<string, number>> {
  const recs = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.clusterId, clusterId));
  const counts: Record<string, number> = {};
  for (const rec of recs) counts[rec.state] = (counts[rec.state] ?? 0) + 1;
  return counts;
}

async function runTask(databaseUrl: string, task: string, clusterId: string): Promise<void> {
  const utils = await makeWorkerUtils({ connectionString: databaseUrl });
  await utils.addJob(task, { clusterId });
  await utils.release();
  await runOnce({ connectionString: databaseUrl, taskList });
}

// Demo the apply pipeline end-to-end against the real demo Mongo: opt out of
// demo mode, 0-day observe window, approve -> hide -> drop.
async function main(): Promise<void> {
  const databaseUrl = requiredEnv("DATABASE_URL");
  const db = createDatabase(databaseUrl);
  const [cluster] = await db.select().from(clusters).orderBy(desc(clusters.createdAt)).limit(1);
  if (cluster === undefined) throw new Error("no cluster — run collect:demo first");

  await db.update(clusters).set({ demoMode: false }).where(eq(clusters.id, cluster.id));
  await db
    .insert(policies)
    .values({ clusterId: cluster.id, observeWindowDays: 0 })
    .onConflictDoUpdate({ target: policies.clusterId, set: { observeWindowDays: 0 } });
  await db
    .update(recommendations)
    .set({ state: "APPROVED", updatedAt: new Date() })
    .where(and(eq(recommendations.clusterId, cluster.id), eq(recommendations.state, "PROPOSED")));
  console.log("after approve: ", await stateCounts(db, cluster.id));

  await runTask(databaseUrl, "apply", cluster.id);
  console.log("after apply (hide): ", await stateCounts(db, cluster.id));

  await runTask(databaseUrl, "finalize", cluster.id);
  console.log("after finalize (drop):", await stateCounts(db, cluster.id));

  const acts = await db.select().from(actions);
  console.log(
    "actions:",
    acts.map((action) => `${action.kind}=${action.result}`),
  );
  process.exit(0);
}

void main();
