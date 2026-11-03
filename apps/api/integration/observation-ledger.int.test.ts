import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  actions,
  clusters,
  createDatabase,
  eq,
  gte,
  observationRuns,
  organizations,
  recommendations,
} from "../src/db";
import { noteOwnOutages, ownOutages, recordObservation } from "../src/jobs/observation-ledger";
import { databaseUrl } from "./helpers";

// The control plane's own record of when it was running (#653), against a real
// postgres: one statement decides whether a tick extends the current stretch or
// opens one past an outage, and only postgres can say it does.
//
// The ledger is deployment-wide, so every instant here is far in the future: the
// rows this suite writes are then the newest whatever else ran first, and the
// cleanup removes exactly them.

const HOUR = 3_600_000;
const T = Date.UTC(2099, 0, 1);

let db: ReturnType<typeof createDatabase>;
let orgId: string;
let recId: string;

beforeAll(async () => {
  db = createDatabase(databaseUrl(), 2);
  const [org] = await db
    .insert(organizations)
    .values({ name: "ledger", slug: `ledger-${Date.now()}`, plan: "FREE" })
    .returning();
  if (org === undefined) throw new Error("could not create the fixture org");
  orgId = org.id;
  const [cluster] = await db
    .insert(clusters)
    .values({
      orgId,
      name: "ledger-fixture",
      sealedDek: Buffer.from("dek"),
      sealedData: Buffer.from("data"),
    })
    .returning();
  if (cluster === undefined) throw new Error("could not create the fixture cluster");
  const [rec] = await db
    .insert(recommendations)
    .values({
      clusterId: cluster.id,
      type: "DROP_UNUSED",
      state: "HIDDEN",
      database: "app",
      collection: "orders",
      indexName: "a_1",
      rationale: "ledger fixture",
      estimatedBytesSaved: 0,
      hiddenAt: new Date(T - HOUR),
      observeDays: 7,
    })
    .returning();
  if (rec === undefined) throw new Error("could not create the fixture recommendation");
  recId = rec.id;
});

afterAll(async () => {
  await db.delete(observationRuns).where(gte(observationRuns.since, new Date(T - 2 * HOUR)));
  await db
    .delete(organizations)
    .where(eq(organizations.id, orgId))
    .catch(() => {});
  await db.$client.end();
});

describe("the observation ledger", () => {
  it("extends a stretch across ticks, and opens a new one past an outage", async () => {
    await recordObservation(db, new Date(T));
    await recordObservation(db, new Date(T + HOUR));
    await recordObservation(db, new Date(T + 2 * HOUR));
    // Three days with no tick at all — the hosted deployment's database out of
    // compute — and then the clock comes back.
    await recordObservation(db, new Date(T + 74 * HOUR));
    await recordObservation(db, new Date(T + 75 * HOUR));

    const mine = await db
      .select()
      .from(observationRuns)
      .where(gte(observationRuns.since, new Date(T - 2 * HOUR)))
      .orderBy(observationRuns.since);
    expect(mine.map((row) => [row.since.getTime(), row.lastSeenAt.getTime()])).toEqual([
      [T, T + 2 * HOUR],
      [T + 74 * HOUR, T + 75 * HOUR],
    ]);
    expect(await ownOutages(db)).toContainEqual({ fromMs: T + 2 * HOUR, toMs: T + 74 * HOUR });
  });

  it("says in a hidden drop's trail which outage of ours it sat through, once", async () => {
    const outages = (await ownOutages(db)).filter((outage) => outage.fromMs >= T);
    const hidden = [{ id: recId, hiddenAt: new Date(T - HOUR) }];
    await noteOwnOutages(db, hidden, outages, T + 75 * HOUR);
    await noteOwnOutages(db, hidden, outages, T + 76 * HOUR);

    const trail = await db
      .select({ result: actions.result })
      .from(actions)
      .where(eq(actions.recommendationId, recId));
    expect(trail.map((row) => row.result)).toEqual([
      "not watched: Indexterity itself was not running from 2099-01-01 02:00 UTC to " +
        "2099-01-04 02:00 UTC, so that stretch is not counted as observation, and the " +
        "observe window moves out by 3 days",
    ]);
  });
});
