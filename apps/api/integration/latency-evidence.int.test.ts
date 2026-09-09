import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ActivityPoint,
  activeHours,
  activeHoursFrom,
  foldActivity,
  foldObservation,
  type LatencyReading,
  observationCanFinish,
  observationCanFinishFrom,
} from "../src/analysis";
import { runFrom } from "../src/analysis/types";
import { asc, clusters, createDatabase, eq, latencySamples, organizations } from "../src/db";
import { workloadKey } from "../src/engine/ports";
import { collectionEvidence } from "../src/jobs/latency-evidence";
import { databaseUrl } from "./helpers";

// The fold that used to happen in JS, now happening in postgres (#484, #485) —
// held to the JS by running both over the same rows.
//
// This is the test the change needs, and it needs it for a specific reason. A SQL
// aggregate that reproduces `foldActivity` and `foldObservation` is a TWIN: two
// implementations of one piece of arithmetic that must agree forever, with nothing
// in the data to notice if they stop. The usual failure is not a crash — it is a
// median cap computed a shade differently, or a dropped window, which moves
// `activeHours` past or short of the seventy-two-hour gate and changes whether
// somebody's index is proposed for deletion. No symptom, no error, wrong verdict.
//
// So the JS stays the definition and every case below asserts the two are EXACTLY
// equal. Every stamp is on a whole second and every span divides evenly, which is
// what makes exact equality the right assertion rather than an approximate one:
// `extract(epoch from interval)::double precision * 1000` and `Date.getTime()`
// agree to the bit on integral milliseconds, and a fixture that needed
// `toBeCloseTo` would be hiding the drift this test exists to catch.
//
// No api and no mongo: rows are inserted, read back, and folded both ways.

const ORG = "1a7e0000-0000-4000-8000-00000000f001";
const CLUSTER = "1a7e0000-0000-4000-8000-00000000c001";
const HOUR = 3_600_000;
const T0 = Date.parse("2026-05-01T00:00:00.000Z");

let db: ReturnType<typeof createDatabase>;

interface Fixture {
  readonly collection: string;
  // Hours after T0 at which the reading was first seen.
  readonly atHours: number;
  // Hours after T0 at which it was last confirmed. Equal to `atHours` for a
  // reading that stood for one collect.
  readonly untilHours: number;
  readonly observations: number;
  readonly readOps: number;
  readonly readLatencyMicros: number;
}

function stamp(hours: number): Date {
  return new Date(T0 + hours * HOUR);
}

async function insert(fixtures: readonly Fixture[]): Promise<void> {
  await db.insert(latencySamples).values(
    fixtures.map((fixture) => ({
      clusterId: CLUSTER,
      database: "ev",
      collection: fixture.collection,
      readOps: fixture.readOps,
      readLatencyMicros: fixture.readLatencyMicros,
      writeOps: 0,
      writeLatencyMicros: 0,
      capturedAt: stamp(fixture.atHours),
      lastSeenAt: stamp(fixture.untilHours),
      observations: fixture.observations,
    })),
  );
}

// The raw rows for one collection, in the shape the analysis was handed before
// this change — read back from postgres rather than rebuilt from the fixtures, so
// the comparison is against what the database actually stored.
async function rawReadings(
  collection: string,
): Promise<{ activity: ActivityPoint[]; latency: LatencyReading[] }> {
  const rows = await db
    .select({
      readOps: latencySamples.readOps,
      readLatencyMicros: latencySamples.readLatencyMicros,
      writeOps: latencySamples.writeOps,
      writeLatencyMicros: latencySamples.writeLatencyMicros,
      capturedAt: latencySamples.capturedAt,
      lastSeenAt: latencySamples.lastSeenAt,
      observations: latencySamples.observations,
      maxGapMs: latencySamples.maxGapMs,
    })
    .from(latencySamples)
    .where(eq(latencySamples.collection, collection))
    .orderBy(asc(latencySamples.capturedAt));
  return {
    activity: rows.map((row) => ({ ...runFrom(row), readOps: row.readOps })),
    latency: rows.map((row) => ({
      ...runFrom(row),
      readOps: row.readOps,
      readLatencyMicros: row.readLatencyMicros,
      writeOps: row.writeOps,
      writeLatencyMicros: row.writeLatencyMicros,
    })),
  };
}

beforeAll(async () => {
  db = createDatabase(databaseUrl(), 2);
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Evidence Fold", slug: `evidence-fold-${process.pid}`, plan: "PRO" })
    .onConflictDoNothing();
  await db
    .insert(clusters)
    .values({
      id: CLUSTER,
      orgId: ORG,
      name: `Evidence Fold ${process.pid}`,
      // The connection string is never opened here: nothing in this file dials
      // anything, it reads latency_samples. The columns are NOT NULL, so they get
      // a byte each.
      sealedDek: Buffer.from([0]),
      sealedData: Buffer.from([0]),
    })
    .onConflictDoNothing();
});

afterAll(async () => {
  // The cluster cascades to latency_samples, and the org to the cluster.
  await db.delete(organizations).where(eq(organizations.id, ORG));
  await db.$client.end();
});

// Every case is a shape that makes the two implementations diverge if either is
// wrong, rather than a shape that merely exercises them.
const FIXTURES: readonly Fixture[] = [
  // BUSY: hourly readings, counter moving every time. The ordinary shape, and the
  // one where the median cap is the cadence.
  {
    collection: "busy",
    atHours: 0,
    untilHours: 0,
    observations: 1,
    readOps: 100,
    readLatencyMicros: 1_000,
  },
  {
    collection: "busy",
    atHours: 1,
    untilHours: 1,
    observations: 1,
    readOps: 200,
    readLatencyMicros: 2_000,
  },
  {
    collection: "busy",
    atHours: 2,
    untilHours: 2,
    observations: 1,
    readOps: 300,
    readLatencyMicros: 3_000,
  },
  {
    collection: "busy",
    atHours: 3,
    untilHours: 3,
    observations: 1,
    readOps: 400,
    readLatencyMicros: 4_000,
  },

  // RUNS: a reading that stood for many collects, so the weighted median has
  // INTERIOR gaps in it as well as gaps between runs. A run contributes no active
  // time however long it is — the counter did not move inside it — and getting
  // that wrong is the error that makes idleness fund its own drops.
  {
    collection: "runs",
    atHours: 0,
    untilHours: 0,
    observations: 1,
    readOps: 10,
    readLatencyMicros: 100,
  },
  {
    collection: "runs",
    atHours: 1,
    untilHours: 9,
    observations: 9,
    readOps: 20,
    readLatencyMicros: 200,
  },
  {
    collection: "runs",
    atHours: 10,
    untilHours: 10,
    observations: 1,
    readOps: 30,
    readLatencyMicros: 300,
  },

  // HOLE: a twelve-hour gap in the middle of an hourly series. The cap is what
  // stops the whole hole being credited as traffic the moment the counter moved
  // anywhere inside it — one outage would otherwise manufacture three days of
  // evidence.
  {
    collection: "hole",
    atHours: 0,
    untilHours: 0,
    observations: 1,
    readOps: 5,
    readLatencyMicros: 50,
  },
  {
    collection: "hole",
    atHours: 1,
    untilHours: 1,
    observations: 1,
    readOps: 15,
    readLatencyMicros: 150,
  },
  {
    collection: "hole",
    atHours: 13,
    untilHours: 13,
    observations: 1,
    readOps: 25,
    readLatencyMicros: 250,
  },
  {
    collection: "hole",
    atHours: 14,
    untilHours: 14,
    observations: 1,
    readOps: 35,
    readLatencyMicros: 350,
  },

  // RESTART: read_ops goes BACKWARDS, which is a cumulative counter that reset.
  // The interval is unknowable, so activity drops it and the observation window
  // drops it — the two do so for different reasons and both have to.
  {
    collection: "restart",
    atHours: 0,
    untilHours: 0,
    observations: 1,
    readOps: 900,
    readLatencyMicros: 9_000,
  },
  {
    collection: "restart",
    atHours: 1,
    untilHours: 1,
    observations: 1,
    readOps: 950,
    readLatencyMicros: 9_500,
  },
  {
    collection: "restart",
    atHours: 2,
    untilHours: 2,
    observations: 1,
    readOps: 10,
    readLatencyMicros: 100,
  },
  {
    collection: "restart",
    atHours: 3,
    untilHours: 3,
    observations: 1,
    readOps: 60,
    readLatencyMicros: 600,
  },

  // EVEN: an even number of gaps of distinct lengths, so the weighted median
  // lands EXACTLY on the halfway mark and the mean-of-the-two-middle branch is
  // the one that answers. A `>` where the JS has `>=` shows up here and nowhere
  // else.
  {
    collection: "even",
    atHours: 0,
    untilHours: 0,
    observations: 1,
    readOps: 1,
    readLatencyMicros: 10,
  },
  {
    collection: "even",
    atHours: 1,
    untilHours: 1,
    observations: 1,
    readOps: 2,
    readLatencyMicros: 20,
  },
  {
    collection: "even",
    atHours: 3,
    untilHours: 3,
    observations: 1,
    readOps: 3,
    readLatencyMicros: 30,
  },
  {
    collection: "even",
    atHours: 7,
    untilHours: 7,
    observations: 1,
    readOps: 4,
    readLatencyMicros: 40,
  },
  {
    collection: "even",
    atHours: 15,
    untilHours: 15,
    observations: 1,
    readOps: 5,
    readLatencyMicros: 50,
  },

  // IDLE: readings whose counter never moves. Real, and the case the run-length
  // storage exists for — no active time at all, and an observation window that is
  // entirely drawable, because time we watched and nothing happened is still time
  // we watched.
  {
    collection: "idle",
    atHours: 0,
    untilHours: 0,
    observations: 1,
    readOps: 7,
    readLatencyMicros: 70,
  },
  {
    collection: "idle",
    atHours: 1,
    untilHours: 5,
    observations: 5,
    readOps: 7,
    readLatencyMicros: 70,
  },
  {
    collection: "idle",
    atHours: 6,
    untilHours: 6,
    observations: 1,
    readOps: 7,
    readLatencyMicros: 70,
  },

  // LONE: one reading, so there is no interval between two and therefore no
  // median. Not zero activity — NOT MEASURABLE, which is a different statement
  // and the one `foldActivity` makes.
  {
    collection: "lone",
    atHours: 0,
    untilHours: 0,
    observations: 1,
    readOps: 42,
    readLatencyMicros: 420,
  },
];

const COLLECTIONS = [...new Set(FIXTURES.map((fixture) => fixture.collection))];

describe("collectionEvidence", () => {
  beforeAll(async () => {
    await insert(FIXTURES);
  });

  it.each(COLLECTIONS)("folds %s exactly as the JS does", async (collection) => {
    const raw = await rawReadings(collection);
    const folded = await collectionEvidence(db, CLUSTER, new Date(0));
    const mine = folded.get(workloadKey("ev", collection));

    expect(mine, "every collection with a reading in the window gets a row").toBeDefined();
    expect(mine?.activity).toEqual(foldActivity(raw.activity));
    expect(mine?.observation).toEqual(foldObservation(raw.latency, "read"));
  });

  // The folds are the means; these two are what the caller actually asks. Asserted
  // separately because a fold can be wrong in a way that cancels — an activeMs and
  // a cap both scaled by the same factor fold differently and read the same.
  it.each(COLLECTIONS)("answers both gates identically for %s", async (collection) => {
    const raw = await rawReadings(collection);
    const folded = await collectionEvidence(db, CLUSTER, new Date(0));
    const mine = folded.get(workloadKey("ev", collection));
    if (mine === undefined) throw new Error(`no evidence for ${collection}`);

    expect(activeHoursFrom(mine.activity)).toBe(activeHours(raw.activity));
    for (const observeDays of [1, 7, 30]) {
      expect(observationCanFinishFrom(mine.observation, observeDays)).toBe(
        observationCanFinish(raw.latency, "read", observeDays),
      );
    }
  });

  // The shapes above are only worth folding if they are actually distinguishable.
  // A fixture set where every collection folded to the same numbers would pass
  // both tests above while proving nothing.
  it("does not fold every shape to the same answer", async () => {
    const folded = await collectionEvidence(db, CLUSTER, new Date(0));
    const hours = COLLECTIONS.map((collection) => {
      const mine = folded.get(workloadKey("ev", collection));
      return mine === undefined ? -1 : activeHoursFrom(mine.activity);
    });
    expect(new Set(hours).size).toBeGreaterThan(3);
    // And the two statements a single reading has to keep apart.
    expect(folded.get(workloadKey("ev", "lone"))?.activity.measurable).toBe(false);
    expect(folded.get(workloadKey("ev", "idle"))?.activity.measurable).toBe(true);
    expect(folded.get(workloadKey("ev", "idle"))?.activity.activeMs).toBe(0);
  });

  // The window is still the plan entitlement and still bounds what may be
  // concluded (D112) — what changed is how many rows crossing the wire it takes.
  // A cutoff inside the series has to move the answer.
  it("honours the window it is given", async () => {
    const late = await collectionEvidence(db, CLUSTER, new Date(T0 + 12 * HOUR));
    // `hole`'s first two readings are outside it; its last two are not.
    const raw = await rawReadings("hole");
    const inside = raw.activity.filter(
      (point) => new Date(point.lastSeenAt ?? point.capturedAt).getTime() >= T0 + 12 * HOUR,
    );
    expect(late.get(workloadKey("ev", "hole"))?.activity).toEqual(foldActivity(inside));
    // And `busy`, entirely before the cutoff, is absent rather than zeroed.
    expect(late.get(workloadKey("ev", "busy"))).toBeUndefined();
  });
});
