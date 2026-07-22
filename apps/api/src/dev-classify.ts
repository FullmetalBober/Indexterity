import { clusters, createDatabase, desc, eq, indexSnapshots, recommendations } from "@repo/db";
import { makeWorkerUtils, runOnce } from "graphile-worker";
import { requiredEnv } from "./env";
import { taskList } from "./jobs/tasks";

// Demo: classify the most recent cluster's snapshots and print the proposals.
async function main(): Promise<void> {
  const databaseUrl = requiredEnv("DATABASE_URL");
  const db = createDatabase(databaseUrl);

  const [cluster] = await db.select().from(clusters).orderBy(desc(clusters.createdAt)).limit(1);
  if (cluster === undefined) {
    throw new Error("no cluster — run `npm run collect:demo -w @repo/api` first");
  }
  const snaps = await db
    .select()
    .from(indexSnapshots)
    .where(eq(indexSnapshots.clusterId, cluster.id));
  if (snaps.length === 0) throw new Error("no snapshots — run collect:demo first");

  const utils = await makeWorkerUtils({ connectionString: databaseUrl });
  await utils.addJob("classify", { clusterId: cluster.id });
  await utils.release();
  await runOnce({ connectionString: databaseUrl, taskList });

  const recs = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.clusterId, cluster.id));
  console.log(
    JSON.stringify(
      recs.map((rec) => ({
        type: rec.type,
        collection: `${rec.database}.${rec.collection}`,
        index: rec.indexName,
        usageClass: rec.usageClass,
        estimatedBytesSaved: rec.estimatedBytesSaved,
        rationale: rec.rationale,
      })),
      null,
      2,
    ),
  );
  process.exit(0);
}

void main();
