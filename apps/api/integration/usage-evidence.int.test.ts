import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { foldUsage, type UsageFold } from "../src/analysis";
import type { MemberUsage, UsageSnapshot } from "../src/analysis/types";
import {
  activityBetween,
  activityInFull,
  countersRestartedBetween,
  latestCounterStart,
} from "../src/analysis/usage";
import {
  clusterIndexes,
  clusters,
  createDatabase,
  eq,
  indexSnapshots,
  organizations,
} from "../src/db";
import { usageEvidence } from "../src/jobs/usage-evidence";
import { databaseUrl } from "./helpers";

// The fold that used to happen in JS, now happening in postgres (#534) — held to
// the JS by running both over the same rows.
//
// A SQL aggregate reproducing `foldUsage` is a TWIN: two implementations of one
// piece of arithmetic that must agree forever, with nothing in the data to notice
// if they stop. The failure is never a crash. It is an epoch summed a shade
// differently, or a burst dated to a run's end instead of its start, which moves
// a verdict across `minHistoryDays` or across `recentHours` and changes whether
// somebody's index is proposed for deletion. No symptom, no error, wrong verdict.
//
// So the JS stays the definition and every case asserts the two are EXACTLY
// equal. Every stamp is on a whole second, which is what makes exact equality the
// right assertion rather than an approximate one: `extract(epoch from
// interval)::double precision * 1000` and `Date.getTime()` agree to the bit on
// integral milliseconds, and a fixture needing `toBeCloseTo` would be hiding the
// drift this test exists to catch.
//
// No api and no mongo: rows are inserted, read back, and folded both ways.

const ORG = "5a9e0000-0000-4000-8000-00000000f001";
const CLUSTER = "5a9e0000-0000-4000-8000-00000000c001";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// A whole second, so both sides land on integral milliseconds.
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

interface RunFixture {
  readonly startMs: number;
  readonly endMs: number;
  readonly observations: number;
  readonly maxGapMs?: number;
  readonly members: readonly MemberUsage[];
  /** Written the way an api predating #537's columns would have. */
  readonly unpriced?: boolean;
}

interface Shape {
  readonly name: string;
  readonly why: string;
  readonly runs: readonly RunFixture[];
}

const SINCE_A = "2025-12-01T00:00:00.000Z";
const SINCE_B = "2026-01-10T00:00:00.000Z";
const one = (ops: number, since?: string): MemberUsage[] => [
  since === undefined ? { member: "m1", ops } : { member: "m1", ops, since },
];

const SHAPES: readonly Shape[] = [
  {
    name: "one_run",
    why: "a single reading — nothing to difference, so it counts in full",
    runs: [{ startMs: BASE, endMs: BASE + HOUR, observations: 1, members: one(40, SINCE_A) }],
  },
  {
    name: "idle_forever",
    why: "one run standing for a month of identical collects, which is what run-length storage is for",
    runs: [{ startMs: BASE, endMs: BASE + 30 * DAY, observations: 720, members: one(0, SINCE_A) }],
  },
  {
    name: "burst_then_silence",
    why: "the counter moves once and then holds still — PERIODIC, and the burst dates to the run's start",
    runs: [
      { startMs: BASE, endMs: BASE + 7 * DAY, observations: 168, members: one(0, SINCE_A) },
      {
        startMs: BASE + 7 * DAY + 1000,
        endMs: BASE + 14 * DAY,
        observations: 168,
        members: one(500, SINCE_A),
      },
      {
        startMs: BASE + 14 * DAY + 1000,
        endMs: BASE + 21 * DAY,
        observations: 168,
        members: one(500, SINCE_A),
      },
    ],
  },
  {
    name: "restart_by_since",
    why: "a member restarted and said so — the epoch splits and the blind window is not credited",
    runs: [
      { startMs: BASE, endMs: BASE + 7 * DAY, observations: 168, members: one(900, SINCE_A) },
      {
        startMs: BASE + 7 * DAY + 1000,
        endMs: BASE + 14 * DAY,
        observations: 168,
        members: one(20, SINCE_B),
      },
    ],
  },
  {
    name: "restart_by_backwards",
    why: "the counter fell with no `since` to notice it by — SQL Server's rebuild, and Mongo rows written before `since` was persisted",
    runs: [
      { startMs: BASE, endMs: BASE + 7 * DAY, observations: 168, members: one(900) },
      {
        startMs: BASE + 7 * DAY + 1000,
        endMs: BASE + 14 * DAY,
        observations: 168,
        members: one(5),
      },
    ],
  },
  {
    name: "gap_between_runs",
    why: "a stretch where nobody was looking, which is the hole the trust gate refuses on",
    runs: [
      { startMs: BASE, endMs: BASE + DAY, observations: 24, members: one(10, SINCE_A) },
      {
        startMs: BASE + 9 * DAY,
        endMs: BASE + 10 * DAY,
        observations: 24,
        members: one(10, SINCE_A),
      },
    ],
  },
  {
    name: "gap_inside_run",
    why: "a run that asserts a span it did not observe evenly — asked rather than believed",
    runs: [
      {
        startMs: BASE,
        endMs: BASE + 10 * DAY,
        observations: 20,
        maxGapMs: 72 * HOUR,
        members: one(0, SINCE_A),
      },
    ],
  },
  {
    name: "many_members",
    why: "a replica set where members differ, and one of them restarts alone",
    runs: [
      {
        startMs: BASE,
        endMs: BASE + 7 * DAY,
        observations: 168,
        members: [
          { member: "m1", ops: 100, since: SINCE_A },
          { member: "m2", ops: 250, since: SINCE_A },
          { member: "m3", ops: 0, since: SINCE_A },
        ],
      },
      {
        startMs: BASE + 7 * DAY + 1000,
        endMs: BASE + 14 * DAY,
        observations: 168,
        members: [
          { member: "m1", ops: 140, since: SINCE_A },
          { member: "m2", ops: 3, since: SINCE_B },
          { member: "m3", ops: 0, since: SINCE_A },
        ],
      },
    ],
  },
  {
    name: "member_joins_and_leaves",
    why: "a member that appears counts in full and does NOT split the epoch, even with a later `since` — so the epoch's counter start is its FIRST run's, not the newest in it",
    runs: [
      {
        startMs: BASE,
        endMs: BASE + 3 * DAY,
        observations: 72,
        members: [
          { member: "m1", ops: 10, since: SINCE_A },
          { member: "m2", ops: 20, since: SINCE_A },
        ],
      },
      {
        startMs: BASE + 3 * DAY + 1000,
        endMs: BASE + 6 * DAY,
        observations: 72,
        members: [
          { member: "m1", ops: 60, since: SINCE_A },
          // Joins LATER than the epoch began. `countersRestartedBetween` skips a
          // member the previous run did not have, so this does not split the
          // epoch — which makes it the one shape that can tell `first_value`
          // from `max` when the epoch's start is computed.
          { member: "m3", ops: 7, since: SINCE_B },
        ],
      },
    ],
  },
  {
    name: "unpriced_rows",
    why: "written by an api predating the stored columns, so both sides must derive from the counters",
    runs: [
      {
        startMs: BASE,
        endMs: BASE + 7 * DAY,
        observations: 168,
        members: one(100, SINCE_A),
        unpriced: true,
      },
      {
        startMs: BASE + 7 * DAY + 1000,
        endMs: BASE + 14 * DAY,
        observations: 168,
        members: one(900, SINCE_A),
        unpriced: true,
      },
    ],
  },
  {
    name: "half_priced",
    why: "a rolling deploy, caught mid-flight: the older row has no stored activity and the newer one does",
    runs: [
      {
        startMs: BASE,
        endMs: BASE + 7 * DAY,
        observations: 168,
        members: one(100, SINCE_A),
        unpriced: true,
      },
      {
        startMs: BASE + 7 * DAY + 1000,
        endMs: BASE + 14 * DAY,
        observations: 168,
        members: one(900, SINCE_A),
      },
    ],
  },
];

let db: ReturnType<typeof createDatabase>;
const indexIdByShape = new Map<string, string>();

// The same arithmetic the collector applies at write time, so a fixture cannot
// describe a run the collector could never have written.
function priceRuns(runs: readonly RunFixture[]) {
  let previous: ReadonlyMap<string, MemberUsage> | null = null;
  return runs.map((run) => {
    const startedAt = latestCounterStart(run.members);
    const stored =
      run.unpriced === true
        ? { opsDelta: null, opsTotal: null, countersRestarted: null, countersStartedAt: null }
        : {
            opsDelta: activityBetween(previous, run.members),
            opsTotal: activityInFull(run.members),
            countersRestarted: countersRestartedBetween(previous, run.members),
            countersStartedAt: startedAt === null ? null : new Date(startedAt),
          };
    previous = new Map(run.members.map((member) => [member.member, member]));
    return { run, stored };
  });
}

// What the engine is handed when the rows are read raw — the fallback path, and
// the definition the SQL is held to.
function historyOf(runs: readonly RunFixture[]): UsageSnapshot[] {
  return priceRuns(runs).map(({ run, stored }) => ({
    capturedAt: new Date(run.startMs).toISOString(),
    lastSeenAt: new Date(run.endMs).toISOString(),
    observations: run.observations,
    maxGapMs: run.maxGapMs ?? 0,
    perMember: run.members,
    opsDelta: stored.opsDelta,
    opsTotal: stored.opsTotal,
    countersRestarted: stored.countersRestarted,
    countersStartedAt: stored.countersStartedAt?.toISOString() ?? null,
  }));
}

beforeAll(async () => {
  db = createDatabase(databaseUrl(), 2);
  await db.delete(clusters).where(eq(clusters.id, CLUSTER));
  await db.delete(organizations).where(eq(organizations.id, ORG));
  await db
    .insert(organizations)
    .values({ id: ORG, name: "Usage Evidence Org", slug: `ue-${process.pid}`, plan: "PRO" })
    .onConflictDoNothing();
  await db.insert(clusters).values({
    id: CLUSTER,
    orgId: ORG,
    name: "Usage Evidence Cluster",
    sealedDek: Buffer.from("integration-dummy"),
    sealedData: Buffer.from("integration-dummy"),
  });

  for (const shape of SHAPES) {
    const [dimension] = await db
      .insert(clusterIndexes)
      .values({
        clusterId: CLUSTER,
        database: "ue",
        collection: "runs",
        indexName: shape.name,
        spec: { name: shape.name, keys: [{ field: shape.name, direction: 1 }] },
      })
      .returning({ id: clusterIndexes.id });
    if (dimension === undefined) throw new Error(`no dimension row for ${shape.name}`);
    indexIdByShape.set(shape.name, dimension.id);
    await db.insert(indexSnapshots).values(
      priceRuns(shape.runs).map(({ run, stored }) => ({
        clusterId: CLUSTER,
        indexId: dimension.id,
        sizeBytes: 4096,
        perMember: [...run.members],
        ...stored,
        capturedAt: new Date(run.startMs),
        lastSeenAt: new Date(run.endMs),
        observations: run.observations,
        maxGapMs: run.maxGapMs ?? 0,
      })),
    );
  }
}, 120_000);

afterAll(async () => {
  await db.delete(clusters).where(eq(clusters.id, CLUSTER));
  await db.delete(organizations).where(eq(organizations.id, ORG));
  await db.$client.end();
});

describe("the usage fold, in postgres and in JS", () => {
  it("covers the shapes the gates actually turn on", () => {
    // A guard on the fixture rather than on the product: the equality below is
    // only worth anything over histories that differ in the ways the gates read.
    expect(SHAPES.length).toBeGreaterThanOrEqual(10);
    expect(new Set(SHAPES.map((shape) => shape.name)).size).toBe(SHAPES.length);
  });

  it("agrees exactly, shape by shape", async () => {
    const folded = await usageEvidence(db, CLUSTER, new Date(BASE - DAY));
    const disagreements: string[] = [];
    for (const shape of SHAPES) {
      const indexId = indexIdByShape.get(shape.name);
      if (indexId === undefined) throw new Error(`no index id for ${shape.name}`);
      const sqlFold = folded.get(indexId)?.usage;
      const jsFold: UsageFold = foldUsage(historyOf(shape.runs));
      if (sqlFold === undefined) {
        disagreements.push(`${shape.name}: postgres folded nothing`);
        continue;
      }
      for (const key of Object.keys(jsFold) as (keyof UsageFold)[]) {
        if (sqlFold[key] !== jsFold[key]) {
          disagreements.push(
            `${shape.name} (${shape.why}) — ${key}: js ${String(jsFold[key])} vs sql ${String(sqlFold[key])}`,
          );
        }
      }
    }
    expect(disagreements).toEqual([]);
  }, 60_000);

  it("folds one row per index, however many runs each has", async () => {
    const folded = await usageEvidence(db, CLUSTER, new Date(BASE - DAY));
    expect(folded.size).toBe(SHAPES.length);
    // The saving, stated as the thing it is: the answer is O(indexes), and the
    // run count is what used to cross the wire.
    const runs = SHAPES.reduce((sum, shape) => sum + shape.runs.length, 0);
    expect(runs).toBeGreaterThan(folded.size);
  });
});
