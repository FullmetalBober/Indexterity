import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  chartEvidence,
  type LatencyReading,
  latencyPoints,
  summarizeLatency,
  trendFrom,
} from "../src/analysis";
import { runFrom } from "../src/analysis/types";
import {
  and,
  asc,
  clusterNamespaces,
  clusters,
  createDatabase,
  eq,
  inArray,
  latencySamples,
  organizations,
} from "../src/db";
import { latencyChartEvidence, latencySummaries } from "../src/insights/latency-folds";
import { databaseUrl, insertLatency } from "./helpers";

// The overview's latency folds against the functions they reproduce (#614).
//
// The two reads used to ship every reading of every collection and reduce it in
// the api. They now reduce in postgres, and these are the same answers or they
// are a regression nobody would see: the before/after table and the chart's
// choice of collections both look plausible either way. So each fixture is read
// back raw and folded both ways, and the two must be equal — exactly, because
// every stamp is on a whole second and every average is the same double divided
// the same way on both sides.

const ORG = "1a7e0000-0000-4000-8000-00000000f614";
const CLUSTER = "1a7e0000-0000-4000-8000-00000000c614";
const HOUR = 3_600_000;
const T0 = Date.parse("2026-06-01T00:00:00.000Z");

let db: ReturnType<typeof createDatabase>;

interface Fixture {
  readonly collection: string;
  readonly atHours: number;
  readonly untilHours?: number;
  readonly observations?: number;
  readonly readOps: number;
  readonly readMicros: number;
  readonly writeOps: number;
  readonly writeMicros: number;
}

const stamp = (hours: number) => new Date(T0 + hours * HOUR);

// Every case is a shape on which the two would diverge if either were wrong.
const FIXTURES: readonly Fixture[] = [
  // Reads and writes moving every hour, at a latency that changes: the baseline
  // is the first window and the current the last, not an average.
  ...[0, 1, 2, 3].map((h) => ({
    collection: "busy",
    atHours: h,
    readOps: 100 * (h + 1),
    readMicros: 1_000 * (h + 1) * (h + 1),
    writeOps: 10 * (h + 1),
    writeMicros: 7_000 * (h + 1),
  })),
  // A total that falls: a restart. The window across it measures nothing, so the
  // current reading is the last window that does.
  {
    collection: "reset",
    atHours: 0,
    readOps: 500,
    readMicros: 50_000,
    writeOps: 5,
    writeMicros: 500,
  },
  {
    collection: "reset",
    atHours: 1,
    readOps: 900,
    readMicros: 90_000,
    writeOps: 9,
    writeMicros: 900,
  },
  { collection: "reset", atHours: 2, readOps: 40, readMicros: 8_000, writeOps: 1, writeMicros: 10 },
  {
    collection: "reset",
    atHours: 3,
    readOps: 140,
    readMicros: 13_000,
    writeOps: 2,
    writeMicros: 30,
  },
  // Readings that stood for several collects: a gap point at the end of each,
  // and the collect count — not the row count — as the samples.
  {
    collection: "runs",
    atHours: 0,
    untilHours: 5,
    observations: 6,
    readOps: 10,
    readMicros: 100,
    writeOps: 0,
    writeMicros: 0,
  },
  {
    collection: "runs",
    atHours: 6,
    untilHours: 6,
    readOps: 20,
    readMicros: 400,
    writeOps: 0,
    writeMicros: 0,
  },
  {
    collection: "runs",
    atHours: 7,
    untilHours: 9,
    observations: 3,
    readOps: 30,
    readMicros: 500,
    writeOps: 0,
    writeMicros: 0,
  },
  // Only ever written: no read window at all, which is what the per-metric
  // ranking exists for.
  ...[0, 1, 2].map((h) => ({
    collection: "written",
    atHours: h,
    readOps: 0,
    readMicros: 0,
    writeOps: 50 * (h + 1),
    writeMicros: 900 * (h + 1),
  })),
  // One reading: nothing to difference, on either side.
  { collection: "single", atHours: 4, readOps: 7, readMicros: 70, writeOps: 7, writeMicros: 70 },
  // Before the window the folds are asked about, so neither may see it.
  {
    collection: "busy",
    atHours: -48,
    readOps: 1,
    readMicros: 999_999,
    writeOps: 1,
    writeMicros: 999_999,
  },
];

const SINCE = stamp(-1);

async function rawReadings(collection: string): Promise<LatencyReading[]> {
  const rows = await db
    .select({
      capturedAt: latencySamples.capturedAt,
      lastSeenAt: latencySamples.lastSeenAt,
      observations: latencySamples.observations,
      maxGapMs: latencySamples.maxGapMs,
      readOps: latencySamples.readOps,
      readLatencyMicros: latencySamples.readLatencyMicros,
      writeOps: latencySamples.writeOps,
      writeLatencyMicros: latencySamples.writeLatencyMicros,
    })
    .from(latencySamples)
    .where(
      and(
        eq(latencySamples.clusterId, CLUSTER),
        inArray(
          latencySamples.namespaceId,
          db
            .select({ id: clusterNamespaces.id })
            .from(clusterNamespaces)
            .where(
              and(
                eq(clusterNamespaces.clusterId, CLUSTER),
                eq(clusterNamespaces.collection, collection),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(latencySamples.capturedAt));
  return rows
    .filter((row) => row.lastSeenAt >= SINCE)
    .map((row) => ({
      ...runFrom(row),
      readOps: row.readOps,
      readLatencyMicros: row.readLatencyMicros,
      writeOps: row.writeOps,
      writeLatencyMicros: row.writeLatencyMicros,
    }));
}

beforeAll(async () => {
  db = createDatabase(databaseUrl(), 2);
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Latency Folds", slug: `latency-folds-${process.pid}`, plan: "PRO" })
    .onConflictDoNothing();
  await db
    .insert(clusters)
    .values({
      id: CLUSTER,
      orgId: ORG,
      name: `Latency Folds ${process.pid}`,
      // Never opened: nothing here dials anything.
      sealedDek: Buffer.from([0]),
      sealedData: Buffer.from([0]),
    })
    .onConflictDoNothing();
  await insertLatency(
    db,
    FIXTURES.map((fixture) => ({
      clusterId: CLUSTER,
      database: "folds",
      collection: fixture.collection,
      readOps: fixture.readOps,
      readLatencyMicros: fixture.readMicros,
      writeOps: fixture.writeOps,
      writeLatencyMicros: fixture.writeMicros,
      capturedAt: stamp(fixture.atHours),
      lastSeenAt: stamp(fixture.untilHours ?? fixture.atHours),
      observations: fixture.observations ?? 1,
    })),
  );
});

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, ORG));
  await db.$client.end();
});

const COLLECTIONS = ["busy", "reset", "runs", "written", "single"];

describe("the overview's latency folds", () => {
  it("summarise each collection exactly as summarizeLatency does", async () => {
    const folded = await latencySummaries(db, CLUSTER, SINCE);
    expect(folded.map((row) => row.collection).sort()).toEqual([...COLLECTIONS].sort());
    for (const collection of COLLECTIONS) {
      const row = folded.find((entry) => entry.collection === collection);
      if (row === undefined) throw new Error(`no summary for ${collection}`);
      const fromFold = trendFrom(
        row.samples,
        { baseline: row.baselineRead, current: row.currentRead },
        { baseline: row.baselineWrite, current: row.currentWrite },
      );
      expect({ collection, ...fromFold }).toEqual({
        collection,
        ...summarizeLatency(await rawReadings(collection)),
      });
    }
  });

  it("count each collection's chart points exactly as latencyPoints draws them", async () => {
    const folded = await latencyChartEvidence(db, CLUSTER, SINCE);
    expect(folded.map((row) => row.collection).sort()).toEqual([...COLLECTIONS].sort());
    for (const collection of COLLECTIONS) {
      const row = folded.find((entry) => entry.collection === collection);
      if (row === undefined) throw new Error(`no evidence for ${collection}`);
      expect({
        collection,
        readPoints: row.readPoints,
        writePoints: row.writePoints,
        points: row.points,
      }).toEqual({ collection, ...chartEvidence(latencyPoints(await rawReadings(collection))) });
    }
  });

  // Not two empty answers agreeing.
  it("measure something on the fixtures", async () => {
    const busy = (await latencySummaries(db, CLUSTER, SINCE)).find(
      (row) => row.collection === "busy",
    );
    expect(busy?.baselineRead).toBe((4_000 - 1_000) / 100);
    expect(busy?.currentRead).toBe((16_000 - 9_000) / 100);
    const runs = (await latencyChartEvidence(db, CLUSTER, SINCE)).find(
      (row) => row.collection === "runs",
    );
    expect(runs?.points).toBe(4);
  });
});
