import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clusters, createDatabase, eq, organizations, recommendations } from "../src/db";
import type { EngineSession, IndexCollector } from "../src/engine/ports";
import { workloadKey } from "../src/engine/ports";
import type { IndexSpec, QueryShape } from "../src/engine/types";
import { openClusterSession } from "../src/jobs/cluster-connection";
import { suggestForCluster } from "../src/jobs/suggest";
import { postgresAdapter } from "../src/postgres/adapter";
import { stub } from "../src/test-utils";
import { databaseUrl } from "./helpers";

// #617. PostgreSQL index names are unique per SCHEMA, and the recommender named
// a build after its keys alone — so two tables in one schema that both wanted an
// index on customer_id were both proposed `customer_id_1`, and the second could
// never be built. The pass now names through the engine.
//
// Against a real postgres for the recommendations and a session that stands in
// for a PostgreSQL cluster, because what is under test is what the pass writes.

vi.mock("../src/jobs/cluster-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs/cluster-connection")>()),
  openClusterSession: vi.fn(),
}));

const pkey = (table: string): IndexSpec => ({
  name: `${table}_pkey`,
  keys: [{ field: "id", direction: 1 }],
  unique: true,
  ttl: false,
  partial: false,
  partialFilter: null,
  sparse: false,
  hidden: false,
  isShardKey: false,
  collation: null,
});

// The same recurring scan on both tables: equality on customer_id, from an
// application, well over every floor.
const scan: QueryShape = {
  equality: ["customer_id"],
  sort: [],
  range: [],
  collscan: true,
  count: 1000,
  docsExamined: 1_000_000_000,
  observedForHours: 168,
  clients: [{ application: "billing", driver: "node-postgres" }],
};

const TABLES = ["public.orders", "public.invoices"];

const collector = stub<IndexCollector>({
  listCollectionNames: async () => TABLES,
  listIndexes: async (_database: string, table: string) => [pkey(table.split(".")[1] ?? table)],
  indexSizes: async () => ({}),
  collectionStorage: async () => ({ dataSizeBytes: 1024 ** 3, docCount: 1_000_000 }),
  collectWorkload: async () => new Map(TABLES.map((table) => [workloadKey("app", table), [scan]])),
  collectDeletePatterns: async () => [],
  collectHintedIndexes: async () => [],
});
const session: EngineSession = {
  collector,
  executor: () => {
    throw new Error("the analysis pass never writes");
  },
  failureWatch: null,
  checkPrivileges: async () => null,
  listDatabaseNames: async () => ["app"],
  ping: async () => undefined,
  close: async () => undefined,
};

let db: ReturnType<typeof createDatabase>;
let orgId: string;
let clusterId: string;

beforeAll(async () => {
  db = createDatabase(databaseUrl(), 2);
  const [org] = await db
    .insert(organizations)
    .values({ name: "postgres-names", slug: `postgres-names-${Date.now()}`, plan: "FREE" })
    .returning();
  if (org === undefined) throw new Error("could not create the fixture org");
  orgId = org.id;
  const [cluster] = await db
    .insert(clusters)
    .values({
      orgId,
      name: "postgres-names-fixture",
      engine: "POSTGRESQL",
      readOnly: false,
      // Never dialled: openClusterSession is the fake above.
      sealedDek: Buffer.from("dek"),
      sealedData: Buffer.from("data"),
    })
    .returning();
  if (cluster === undefined) throw new Error("could not create the fixture cluster");
  clusterId = cluster.id;
  vi.mocked(openClusterSession).mockResolvedValue({
    session,
    engine: "POSTGRESQL",
    readOnly: false,
    canHide: false,
    canPartial: false,
    nameIndex: postgresAdapter.indexName,
    observedDatabases: null,
    release: () => undefined,
  });
});

afterAll(async () => {
  await db
    .delete(organizations)
    .where(eq(organizations.id, orgId))
    .catch(() => {});
  await db.$client.end();
});

describe("two tables in one PostgreSQL schema wanting the same index", () => {
  it("are proposed under two names, each carrying its table", async () => {
    await suggestForCluster(db, clusterId);

    const proposed = await db
      .select({ collection: recommendations.collection, indexName: recommendations.indexName })
      .from(recommendations)
      .where(eq(recommendations.clusterId, clusterId));
    expect(proposed.sort((a, b) => a.collection.localeCompare(b.collection))).toEqual([
      { collection: "public.invoices", indexName: "invoices_customer_id_idx" },
      { collection: "public.orders", indexName: "orders_customer_id_idx" },
    ]);
  });
});
