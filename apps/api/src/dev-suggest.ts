import {
  clusters,
  createDatabase,
  envKeyProvider,
  eq,
  organizations,
  policies,
  recommendations,
  seal,
} from "@repo/db";
import { MongoConnection } from "@repo/mongo";
import { makeWorkerUtils, runOnce } from "graphile-worker";
import { masterKeyBytes, requiredEnv } from "./env";
import { taskList } from "./jobs/tasks";

// Demo workload analysis: profile slow collection scans on an unindexed field,
// then run suggest → a CREATE recommendation.
async function main(): Promise<void> {
  const databaseUrl = requiredEnv("DATABASE_URL");
  const mongoUrl = requiredEnv("DEMO_MONGO_URL");
  const db = createDatabase(databaseUrl);

  const mongo = new MongoConnection(mongoUrl);
  await mongo.connect();
  const appdb = mongo.db("appdb");
  const coll = appdb.collection("regress");
  if ((await coll.countDocuments()) < 30000) {
    const docs = Array.from({ length: 30000 }, (_, i) => ({
      customerId: `c${i % 1000}`,
      status: i % 2 === 0 ? "open" : "closed",
    }));
    await coll.insertMany(docs);
  }
  // Profile all ops, then run collection scans on `status` (no index).
  await appdb.command({ profile: 2 });
  for (let i = 0; i < 8; i += 1) await coll.find({ status: "open" }).toArray();
  await appdb.command({ profile: 0 });
  await mongo.close();

  const sealed = await seal(new TextEncoder().encode(mongoUrl), envKeyProvider(masterKeyBytes()));
  const [org] = await db.insert(organizations).values({ name: "Suggest Org" }).returning();
  if (org === undefined) throw new Error("org insert failed");
  const [cluster] = await db
    .insert(clusters)
    .values({
      orgId: org.id,
      name: "Suggest Cluster",
      connectionMode: "HOSTED_DIRECT",
      demoMode: true,
      sealedDek: Buffer.from(sealed.dek),
      sealedData: Buffer.from(sealed.data),
    })
    .returning();
  if (cluster === undefined) throw new Error("cluster insert failed");
  await db.insert(policies).values({ clusterId: cluster.id, workloadAnalysis: true });

  const utils = await makeWorkerUtils({ connectionString: databaseUrl });
  await utils.addJob("suggest", { clusterId: cluster.id });
  await utils.release();
  await runOnce({ connectionString: databaseUrl, taskList });

  const recs = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.clusterId, cluster.id));
  console.log(`workload recommendations: ${recs.length}`);
  for (const rec of recs) {
    console.log(
      `  ${rec.type} ${rec.database}.${rec.collection} ${rec.indexName} — ${rec.rationale}`,
    );
  }
  process.exit(0);
}

void main();
