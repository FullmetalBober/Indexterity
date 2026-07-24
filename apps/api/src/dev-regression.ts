import {
  actions,
  clusters,
  createDatabase,
  envKeyProvider,
  eq,
  organizations,
  policies,
  recommendations,
  seal,
} from "@repo/db";
import { MongoConnection, MongoIndexCollector, MongoIndexExecutor } from "@repo/mongo";
import { makeWorkerUtils, runOnce } from "graphile-worker";
import { masterKeyBytes, requiredEnv } from "./env";
import { taskList } from "./jobs/tasks";

// Force a read-latency regression and prove finalize un-hides instead of dropping.
async function main(): Promise<void> {
  const databaseUrl = requiredEnv("DATABASE_URL");
  const mongoUrl = requiredEnv("DEMO_MONGO_URL");
  const db = createDatabase(databaseUrl);

  const mongo = new MongoConnection(mongoUrl);
  await mongo.connect();
  const collector = new MongoIndexCollector(mongo);
  const executor = new MongoIndexExecutor(mongo, false);
  const coll = mongo.db("appdb").collection("regress");
  await coll.createIndexes([{ key: { customerId: 1 }, name: "customerId_1" }]);
  if ((await coll.countDocuments()) < 30000) {
    const docs = Array.from({ length: 30000 }, (_, i) => ({
      customerId: `c${i % 1000}`,
      status: "open",
    }));
    await coll.insertMany(docs);
  }

  // Baseline: queries served BY the index (fast).
  for (let i = 0; i < 200; i += 1) await coll.find({ customerId: `c${i % 1000}` }).toArray();

  // Hide the index and capture the pre-regression baseline latency.
  await executor.hide("appdb", "regress", "customerId_1");
  const baseline = await collector.readLatency("appdb", "regress");

  // Seed a non-demo cluster + a HIDDEN recommendation carrying that baseline.
  const sealed = await seal(new TextEncoder().encode(mongoUrl), envKeyProvider(masterKeyBytes()));
  const [org] = await db.insert(organizations).values({ name: "Regress Org" }).returning();
  if (org === undefined) throw new Error("org insert failed");
  const [cluster] = await db
    .insert(clusters)
    .values({
      orgId: org.id,
      name: "Regress Cluster",
      connectionMode: "HOSTED_DIRECT",
      demoMode: false,
      sealedDek: Buffer.from(sealed.dek),
      sealedData: Buffer.from(sealed.data),
    })
    .returning();
  if (cluster === undefined) throw new Error("cluster insert failed");
  await db.insert(policies).values({ clusterId: cluster.id, observeWindowDays: 0 });
  const [rec] = await db
    .insert(recommendations)
    .values({
      clusterId: cluster.id,
      type: "DROP_UNUSED",
      state: "HIDDEN",
      database: "appdb",
      collection: "regress",
      indexName: "customerId_1",
      rationale: "unused (demo)",
      estimatedBytesSaved: 0,
      hiddenAt: new Date(),
      baselineReadOps: baseline.ops,
      baselineReadLatency: baseline.latencyMicros,
    })
    .returning();
  if (rec === undefined) throw new Error("rec insert failed");

  // Generate load WITHOUT the index (collscan on 30k docs, slow).
  for (let i = 0; i < 200; i += 1) await coll.find({ customerId: `c${i % 1000}` }).toArray();
  const afterLoad = await collector.readLatency("appdb", "regress");
  await mongo.close();

  const baseAvg = baseline.ops > 0 ? baseline.latencyMicros / baseline.ops : 0;
  const windowOps = afterLoad.ops - baseline.ops;
  const windowAvg =
    windowOps > 0 ? (afterLoad.latencyMicros - baseline.latencyMicros) / windowOps : 0;
  console.log(
    `baseline avg ${baseAvg.toFixed(0)}µs → window avg ${windowAvg.toFixed(0)}µs over ${windowOps} reads`,
  );

  // finalize (observe window 0) — should detect the regression and un-hide.
  const utils = await makeWorkerUtils({ connectionString: databaseUrl });
  await utils.addJob("finalize", { clusterId: cluster.id });
  await utils.release();
  await runOnce({ connectionString: databaseUrl, taskList });

  const [after] = await db.select().from(recommendations).where(eq(recommendations.id, rec.id));
  const acts = await db.select().from(actions).where(eq(actions.recommendationId, rec.id));
  console.log(`rec state: ${after?.state} (PROPOSED = un-hidden, DROPPED = dropped)`);
  console.log(
    "actions:",
    acts.map((action) => `${action.kind}=${action.result}`),
  );
  process.exit(0);
}

void main();
