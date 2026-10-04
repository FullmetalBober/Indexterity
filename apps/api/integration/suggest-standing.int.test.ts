import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  clusters,
  createDatabase,
  eq,
  organizations,
  recommendations,
  workloadShapes,
} from "../src/db";
import type { EngineSession, IndexCollector } from "../src/engine/ports";
import { workloadKey } from "../src/engine/ports";
import type { IndexSpec, QueryShape } from "../src/engine/types";
import { openClusterSession } from "../src/jobs/cluster-connection";
import { suggestForCluster } from "../src/jobs/suggest";
import { stub } from "../src/test-utils";
import { databaseUrl } from "./helpers";

// A shape whose index is already approved is recorded as `standing` — and since
// #608 with the index's name, the way a proposal is. That name is how the build
// finds the shapes it was for once approval has taken it out of PROPOSED: the
// ledger is rewritten every pass, so a shape that read `proposed` while the row
// waited reads `standing` by the time the change window comes round.
//
// Against a real postgres and a session that stands in for a MongoDB, because
// what is under test is what the pass writes, not what a server reports.

vi.mock("../src/jobs/cluster-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs/cluster-connection")>()),
  openClusterSession: vi.fn(),
}));

const idIndex: IndexSpec = {
  name: "_id_",
  keys: [{ field: "_id", direction: 1 }],
  unique: true,
  ttl: false,
  partial: false,
  partialFilter: null,
  sparse: false,
  hidden: false,
  isShardKey: false,
  collation: null,
};

// A recurring collection scan on `status` from an application: well over every
// floor, so the create side derives `status_1` for it.
const scan: QueryShape = {
  equality: ["status"],
  sort: [],
  range: [],
  collscan: true,
  count: 1000,
  docsExamined: 1_000_000_000,
  observedForHours: 168,
  clients: [{ application: "checkout-api", driver: "nodejs" }],
};

const collector = stub<IndexCollector>({
  listCollectionNames: async () => ["orders"],
  listIndexes: async () => [idIndex],
  indexSizes: async () => ({ _id_: 1024 }),
  collectionStorage: async () => ({ dataSizeBytes: 1024 ** 3, docCount: 1_000_000 }),
  collectWorkload: async () => new Map([[workloadKey("app", "orders"), [scan]]]),
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
    .values({ name: "suggest-standing", slug: `suggest-standing-${Date.now()}`, plan: "FREE" })
    .returning();
  if (org === undefined) throw new Error("could not create the fixture org");
  orgId = org.id;
  const [cluster] = await db
    .insert(clusters)
    .values({
      orgId,
      name: "suggest-standing-fixture",
      engine: "MONGODB",
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
    engine: "MONGODB",
    readOnly: false,
    canHide: true,
    canPartial: true,
    observedDatabases: null,
    release: () => undefined,
  });
  // The owner approved it on an earlier pass; it waits for the change window.
  await db.insert(recommendations).values({
    clusterId,
    type: "CREATE",
    state: "APPROVED",
    source: "WORKLOAD",
    database: "app",
    collection: "orders",
    indexName: "status_1",
    rationale: "approved on an earlier pass",
    score: 70,
    targetSpec: { keys: ["status"], retire: [] },
  });
});

afterAll(async () => {
  await db
    .delete(organizations)
    .where(eq(organizations.id, orgId))
    .catch(() => {});
  await db.$client.end();
});

describe("a shape whose index is already approved", () => {
  it("is recorded as standing, naming the index that answers it", async () => {
    await suggestForCluster(db, clusterId);

    const rows = await db
      .select({ outcome: workloadShapes.outcome, proposedIndex: workloadShapes.proposedIndex })
      .from(workloadShapes)
      .where(eq(workloadShapes.clusterId, clusterId));
    expect(rows).toEqual([{ outcome: "standing", proposedIndex: "status_1" }]);

    // And it was not proposed a second time.
    const proposals = await db
      .select({ state: recommendations.state })
      .from(recommendations)
      .where(eq(recommendations.clusterId, clusterId));
    expect(proposals).toEqual([{ state: "APPROVED" }]);
  });
});
