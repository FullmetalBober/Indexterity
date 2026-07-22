import {
  clusters,
  createDatabase,
  envKeyProvider,
  eq,
  indexSnapshots,
  organizations,
  seal,
} from "@repo/db";
import { MongoConnection } from "@repo/mongo";
import { makeWorkerUtils, runOnce } from "graphile-worker";
import { masterKeyBytes, requiredEnv } from "./env";
import { taskList } from "./jobs/collect";

// One-shot demo: seed a demo Mongo + cluster row, enqueue collect, run it once,
// print the snapshots written. Not part of the production flow.
async function main(): Promise<void> {
  const mongoUrl = requiredEnv("DEMO_MONGO_URL");
  const databaseUrl = requiredEnv("DATABASE_URL");

  // 1. Seed the demo Mongo with a collection + a few indexes.
  const mongo = new MongoConnection(mongoUrl);
  await mongo.connect();
  const orders = mongo.db("appdb").collection("orders");
  await orders.createIndexes([
    { key: { customerId: 1 }, name: "customerId_1" },
    { key: { customerId: 1, createdAt: -1 }, name: "customerId_1_createdAt_-1" },
    { key: { status: 1 }, name: "status_1" },
  ]);
  await orders.insertOne({ customerId: "c1", status: "open", createdAt: new Date() });
  await mongo.close();

  // 2. Seed an org + cluster with the sealed connection string.
  const db = createDatabase(databaseUrl);
  const sealed = await seal(new TextEncoder().encode(mongoUrl), envKeyProvider(masterKeyBytes()));
  const [org] = await db.insert(organizations).values({ name: "Demo Org" }).returning();
  if (org === undefined) throw new Error("failed to insert org");
  const [cluster] = await db
    .insert(clusters)
    .values({
      orgId: org.id,
      name: "Demo Cluster",
      connectionMode: "HOSTED_DIRECT",
      demoMode: true,
      sealedDek: Buffer.from(sealed.dek),
      sealedData: Buffer.from(sealed.data),
    })
    .returning();
  if (cluster === undefined) throw new Error("failed to insert cluster");

  // 3. Enqueue + process the collect job.
  const utils = await makeWorkerUtils({ connectionString: databaseUrl });
  await utils.addJob("collect", { clusterId: cluster.id });
  await utils.release();
  await runOnce({ connectionString: databaseUrl, taskList });

  // 4. Report what landed in Postgres.
  const snapshots = await db
    .select()
    .from(indexSnapshots)
    .where(eq(indexSnapshots.clusterId, cluster.id));
  console.log(
    JSON.stringify(
      snapshots.map((row) => ({
        database: row.database,
        collection: row.collection,
        index: row.indexName,
        sizeBytes: row.sizeBytes,
        perMember: row.perMember,
      })),
      null,
      2,
    ),
  );
  process.exit(0);
}

void main();
