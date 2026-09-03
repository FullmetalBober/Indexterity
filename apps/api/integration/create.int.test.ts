import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  actions,
  clusters,
  createDatabase,
  eq,
  inArray,
  organizations,
  recommendations,
} from "../src/db";
import type {
  CreateIndexOptions,
  EngineSession,
  IndexBuildOutcome,
  IndexCollector,
  IndexExecutor,
} from "../src/engine/ports";
import { IndexBuildRefusedError } from "../src/engine/ports";
import { openClusterSession } from "../src/jobs/cluster-connection";
import { applyCreatesForCluster } from "../src/jobs/create";
import { stub } from "../src/test-utils";
import { databaseUrl } from "./helpers";

// What the create pass does with a build the adapter refuses (#452), against a
// real postgres and a session that stands in for a SQL Server.
//
// The production shape: a partial CREATE the recommender proposed for SQL Server,
// approved, and refused by the executor because a `{column: literal}` filter is
// not a T-SQL predicate. Before this the refusal was an unsupported-version
// block on the whole cluster, nothing was written against the row, and every
// other approved build on the cluster waited behind it. Now the row closes as
// REJECTED with the refusal in its rationale and its history, and the next build
// in the same pass still lands.
//
// The session is faked at `openClusterSession` because no real engine is needed:
// the refusal is the adapter's own decision, and the pass's reaction to it is
// what is under test. The two rows in the table are real.

vi.mock("../src/jobs/cluster-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/jobs/cluster-connection")>()),
  openClusterSession: vi.fn(),
}));

const REFUSAL = "cannot create a filtered index from a non-SQL filter expression";
const idle = { ops: 0, latencyMicros: 0 };

// Refuses any partial filter — the SQL Server executor's rule — and builds
// everything else, recording what it was asked for.
const built: string[] = [];
const executor = stub<IndexExecutor>({
  create: vi.fn(
    async (
      _database: string,
      _collection: string,
      _keys: Record<string, 1 | -1>,
      options: CreateIndexOptions,
    ): Promise<IndexBuildOutcome> => {
      if (options.partialFilterExpression !== undefined) throw new IndexBuildRefusedError(REFUSAL);
      built.push(options.name ?? "");
      return "BUILT";
    },
  ),
});
// Only the write-latency baseline a landed build records is ever read.
const collector = stub<IndexCollector>({
  collectionLatency: async () => ({ reads: idle, writes: idle }),
});
const session: EngineSession = {
  collector,
  executor: () => executor,
  listDatabaseNames: async () => ["PlatformPlan"],
  ping: async () => undefined,
  close: async () => undefined,
};

let db: ReturnType<typeof createDatabase>;
let orgId: string;
let clusterId: string;
let refusedId: string;
let plainId: string;

beforeAll(async () => {
  db = createDatabase(databaseUrl(), 2);
  const [org] = await db
    .insert(organizations)
    .values({ name: "create-refusal", slug: `create-refusal-${Date.now()}`, plan: "FREE" })
    .returning();
  if (org === undefined) throw new Error("could not create the fixture org");
  orgId = org.id;

  const [cluster] = await db
    .insert(clusters)
    .values({
      orgId,
      name: "create-refusal-fixture",
      engine: "MSSQL",
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
    engine: "MSSQL",
    readOnly: false,
    canHide: true,
    canPartial: false,
    observedDatabases: null,
    release: () => undefined,
  });

  // The production row, and an ordinary build approved beside it.
  const rows = await db
    .insert(recommendations)
    .values([
      {
        clusterId,
        type: "CREATE",
        state: "APPROVED",
        source: "WORKLOAD",
        database: "PlatformPlan",
        collection: "dbo.ClientPlans",
        indexName: "ClientID_1_DisplayOrder_1_partial",
        rationale: "Add an index on {ClientID, DisplayOrder} — collection scan seen 39×.",
        score: 70,
        estimatedBytesSaved: 0,
        targetSpec: {
          keys: ["ClientID", "DisplayOrder"],
          retire: [],
          partial: { IsActive: 1, IsDeleted: 0 },
        },
      },
      {
        clusterId,
        type: "CREATE",
        state: "APPROVED",
        source: "WORKLOAD",
        database: "PlatformPlan",
        collection: "dbo.Invoices",
        indexName: "ClientID_1_IssuedAt_-1",
        rationale: "Add an index on {ClientID, IssuedAt: -1} — collection scan seen 12×.",
        score: 70,
        estimatedBytesSaved: 0,
        targetSpec: { keys: ["ClientID", "IssuedAt:-1"], retire: [] },
      },
    ])
    .returning({ id: recommendations.id, indexName: recommendations.indexName });
  const refused = rows.find((row) => row.indexName.endsWith("_partial"));
  const plain = rows.find((row) => !row.indexName.endsWith("_partial"));
  if (refused === undefined || plain === undefined) throw new Error("fixture rows missing");
  refusedId = refused.id;
  plainId = plain.id;
});

afterAll(async () => {
  await db
    .delete(organizations)
    .where(eq(organizations.id, orgId))
    .catch(() => {});
  await db.$client.end();
});

describe("a build the adapter refuses", () => {
  it("is recorded against its row and does not stop the next build", async () => {
    // One build landed: the pass survived the refusal.
    expect(await applyCreatesForCluster(db, clusterId)).toBe(1);
    expect(executor.create).toHaveBeenCalledTimes(2);
    expect(built).toEqual(["ClientID_1_IssuedAt_-1"]);

    const rows = await db
      .select({
        id: recommendations.id,
        state: recommendations.state,
        rationale: recommendations.rationale,
      })
      .from(recommendations)
      .where(inArray(recommendations.id, [refusedId, plainId]));
    const refused = rows.find((row) => row.id === refusedId);
    const plain = rows.find((row) => row.id === plainId);

    // Closed, with the reason where the owner reads the row — not PROPOSED,
    // which would offer an approve that can only be refused again.
    expect(refused?.state).toBe("REJECTED");
    expect(refused?.rationale).toContain(`refused by the engine: ${REFUSAL}`);
    expect(plain?.state).toBe("ACTIVE");

    const history = await db
      .select({ recommendationId: actions.recommendationId, result: actions.result })
      .from(actions)
      .where(inArray(actions.recommendationId, [refusedId, plainId]));
    expect(history).toEqual(
      expect.arrayContaining([
        { recommendationId: refusedId, result: `refused: ${REFUSAL}` },
        { recommendationId: plainId, result: "ok" },
      ]),
    );
    expect(history).toHaveLength(2);
  });

  it("leaves nothing approved behind, so the next tick has nothing to refuse again", async () => {
    expect(await applyCreatesForCluster(db, clusterId)).toBe(0);
    expect(executor.create).toHaveBeenCalledTimes(2);
  });
});
