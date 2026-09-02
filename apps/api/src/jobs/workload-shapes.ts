import type { WorkloadOutcome } from "@repo/contracts";
import { z } from "zod";
import { executionsPerWeek, type ScanSeverity, scanCost } from "../analysis";
import type { Database } from "../db";
import { sql, workloadShapes } from "../db";
import type { QueryShape } from "../engine/types";

// Accumulating the create side's verdict on every scanning shape it read, and
// writing it down (#432).
//
// Kept out of jobs/suggest.ts because that file is already the longest in the
// pipeline and this is a separate concern with a separate invariant: suggest
// decides, this records. What it must NOT do is decide anything — every outcome
// arrives from the gate that fired, so nothing here re-applies a rule.

// The shape as stored: the ESR split plus which failure it is. Exactly what an
// index would have to cover, and nothing about who ran it or when.
//
// `constants` is absent BY CONSTRUCTION, not by omission, and that is the
// storage decision this feature turned on (D128). It is the one field on a
// `QueryShape` carrying real customer VALUES — only the profiler populates it,
// since `$queryStats` shapifies literals away, and the profiler is the workload
// source below MongoDB 8.0 which D94 shipped on by default. That decision
// accepted the trust cost of a TRANSIENT read; writing the same values into our
// control-plane postgres is a different question. The page has no use for a
// literal, so the values go on being used in memory to derive a partial-index
// candidate and are never persisted.
//
// Field order is fixed here rather than spread from the shape, which is what
// makes the stored jsonb canonical for the generated digest: Postgres sorts
// jsonb keys itself, so two equal shapes hash equal however they were built —
// but only if the same FIELDS are present, and spreading a QueryShape would
// carry whatever optional keys that reading happened to have.
export interface StoredShape {
  readonly equality: readonly string[];
  readonly sort: readonly { readonly field: string; readonly direction: 1 | -1 }[];
  readonly range: readonly string[];
  readonly collscan: boolean;
  readonly sortedInMemory: boolean;
}

// Rehydrating a stored shape, for the read side (no `as`).
//
// Beside the writer on purpose: the two halves of a jsonb column's contract are
// the only pair in this file that MUST agree, and separating them is how a field
// gets added to one and not the other.
export const storedShapeSchema = z.object({
  equality: z.array(z.string()),
  sort: z.array(z.object({ field: z.string(), direction: z.union([z.literal(1), z.literal(-1)]) })),
  range: z.array(z.string()),
  collscan: z.boolean(),
  sortedInMemory: z.boolean(),
});

// `ScanSeverity` as the column holds it. Text rather than an enum for the same
// reason `outcome` is, so an unrecognised grade falls back to the mildest rather
// than failing the page — overstating severity from a value we cannot read would
// be the worse direction to guess in.
export function severityOf(value: string): ScanSeverity {
  return value === "CRITICAL" || value === "ELEVATED" ? value : "ROUTINE";
}

export function storedShapeOf(shape: QueryShape): StoredShape {
  return {
    equality: [...shape.equality],
    sort: shape.sort.map((key) => ({ field: key.field, direction: key.direction })),
    range: [...shape.range],
    collscan: shape.collscan,
    sortedInMemory: shape.sortedInMemory === true,
  };
}

// Is this shape a finding at all? A shape the planner served from an index is
// not, and storing it would make the table the size of the workload rather than
// the size of the problem.
export function isScanning(shape: QueryShape): boolean {
  return shape.collscan || shape.sortedInMemory === true;
}

// One shape's row, before it is written.
export interface PendingShape {
  readonly database: string;
  readonly collection: string;
  readonly shape: StoredShape;
  readonly executions: number;
  readonly docsExamined: number | null;
  readonly observedForHours: number | null;
  readonly clients: { application?: string; driver?: string }[];
  readonly weeklyDocsExamined: number | null;
  readonly severity: ScanSeverity;
  outcome: WorkloadOutcome;
  proposedIndex: string | null;
}

// Documents this shape walks per week.
//
// The same arithmetic `weeklyScanCost` sums, applied to one shape and WITHOUT
// its `if (!collscan) continue` — that skip is right for a scan-cost total and
// wrong for a page that has to rank a blocking sort somewhere other than the
// bottom. Where the source reports no examined count a collection scan walks the
// whole collection by definition, which is the fallback that function documents;
// an in-memory sort has no such identity, so it comes back null rather than
// zero, because zero would read as "this costs nothing".
function weeklyDocsExaminedOf(shape: QueryShape, docCount: number): number | null {
  const examined = shape.docsExamined ?? (shape.collscan ? shape.count * docCount : null);
  if (examined === null) return null;
  const perExecution = shape.count > 0 ? examined / shape.count : 0;
  return Math.round(perExecution * executionsPerWeek(shape));
}

// The pass's account of every scanning shape it read.
//
// Keyed the way the table is — namespace plus the shape itself — so a shape
// reported twice by one pass (the two workload sources can both answer for a
// namespace) is one row, and so that a verdict arriving later in the pass finds
// the row an earlier one created.
export class ShapeLedger {
  private readonly rows = new Map<string, PendingShape>();

  private static key(database: string, collection: string, shape: StoredShape): string {
    return `${database}\u0000${collection}\u0000${JSON.stringify(shape)}`;
  }

  // Record a shape with the verdict it has SO FAR. Called once per scanning
  // shape as the collection is analysed, before any candidate is known, so the
  // row exists whatever happens next.
  //
  // `docCount` is the collection's size, and it is here rather than on the row
  // because it is not a fact about the shape: the two derived numbers need it
  // (see the schema), and nothing else does.
  note(
    database: string,
    collection: string,
    shape: QueryShape,
    docCount: number,
    outcome: WorkloadOutcome,
    proposedIndex: string | null = null,
  ): void {
    const stored = storedShapeOf(shape);
    const key = ShapeLedger.key(database, collection, stored);
    const already = this.rows.get(key);
    if (already !== undefined) {
      // Later wins, with one exception. Later means further down the pipeline:
      // the collection is entered by seeding every scanning shape at
      // `no-candidate` so none can go unrecorded, and each producer then
      // overwrites with the gate that actually fired.
      //
      // The exception is `proposed`, which is sticky. Three producers read the
      // same shapes and they disagree by design — a re-order answers an
      // in-memory sort that the create rule declines as already indexed — so a
      // shape one of them acted on must not read as declined because another
      // had nothing to say about it.
      if (already.outcome === "proposed") return;
      already.outcome = outcome;
      already.proposedIndex = proposedIndex;
      return;
    }
    this.rows.set(key, {
      database,
      collection,
      shape: stored,
      executions: shape.count,
      docsExamined: shape.docsExamined ?? null,
      observedForHours: shape.observedForHours ?? null,
      // Nulls stripped rather than stored: `{ application: null }` and `{}` are
      // the same fact, and only one of them keeps the digest stable across
      // driver versions that stopped reporting a field.
      clients: (shape.clients ?? []).map((client) => ({
        ...(client.application === undefined ? {} : { application: client.application }),
        ...(client.driver === undefined ? {} : { driver: client.driver }),
      })),
      weeklyDocsExamined: weeklyDocsExaminedOf(shape, docCount),
      // `scanCost`'s own verdict, taken rather than re-derived — see the column.
      severity: scanCost(shape, docCount).severity,
      outcome,
      proposedIndex,
    });
  }

  // Mark every shape a candidate answers. The candidate carries them — see
  // `CreateCandidate.sourceShapes` — so this is attribution rather than a second
  // application of the rules.
  resolve(
    database: string,
    collection: string,
    docCount: number,
    shapes: readonly QueryShape[],
    outcome: WorkloadOutcome,
    proposedIndex: string | null = null,
  ): void {
    for (const shape of shapes) {
      if (!isScanning(shape)) continue;
      this.note(database, collection, shape, docCount, outcome, proposedIndex);
    }
  }

  get size(): number {
    return this.rows.size;
  }

  // What the pass recorded, for anything that wants to read it back before it is
  // written — the tests, and any caller that wants to log or count the verdicts
  // without a second round trip. One accessor rather than one per field: the row
  // is the unit the ledger deals in.
  entries(): readonly PendingShape[] {
    return [...this.rows.values()];
  }

  // Upsert the lot, one statement.
  //
  // `first_seen_at` is kept from the row that exists and `observations` is
  // incremented, so the pair says "first seen then, still true now, confirmed
  // this many times" — which is the whole question the page asks and the reason
  // this table is one row per shape rather than a series (see the schema).
  //
  // The measurement columns are REPLACED with the newest reading rather than
  // accumulated: the source's own counters are already cumulative from its
  // start, so adding ours on top would double-count (D26).
  async flush(db: Database, clusterId: string, now: Date): Promise<void> {
    const pending = [...this.rows.values()];
    if (pending.length === 0) return;
    await db
      .insert(workloadShapes)
      .values(
        pending.map((row) => ({
          clusterId,
          database: row.database,
          collection: row.collection,
          shape: { ...row.shape },
          executions: row.executions,
          docsExamined: row.docsExamined,
          observedForHours: row.observedForHours,
          clients: row.clients,
          weeklyDocsExamined: row.weeklyDocsExamined,
          severity: row.severity,
          outcome: row.outcome,
          proposedIndex: row.proposedIndex,
          firstSeenAt: now,
          lastSeenAt: now,
          observations: 1,
        })),
      )
      .onConflictDoUpdate({
        target: [
          workloadShapes.clusterId,
          workloadShapes.database,
          workloadShapes.collection,
          workloadShapes.shapeDigest,
        ],
        set: {
          executions: sql`excluded.executions`,
          docsExamined: sql`excluded.docs_examined`,
          observedForHours: sql`excluded.observed_for_hours`,
          clients: sql`excluded.clients`,
          weeklyDocsExamined: sql`excluded.weekly_docs_examined`,
          severity: sql`excluded.severity`,
          outcome: sql`excluded.outcome`,
          proposedIndex: sql`excluded.proposed_index`,
          lastSeenAt: sql`excluded.last_seen_at`,
          observations: sql`${workloadShapes.observations} + 1`,
        },
      });
  }
}
