import { OPEN_SCANS_WINDOW_DAYS } from "@repo/contracts";
import { and, type Database, eq, gte, workloadShapes } from "../db";

const DAY_MS = 86_400_000;

// The scanning a build was for (#608), read the moment the index is built.
//
// The workload ledger names the index that answers each scanning shape — as
// `proposed` while the recommendation waits for review, as `standing` once it is
// approved — so the shapes are the ones carrying this name in this collection,
// seen recently enough to be scanning now. The overview later asks which of the
// same shapes are still seen scanning, which is the only honest "after" there
// is: a shape the index serves is no longer a scanning shape, so it stops being
// written at all.
//
// Null when there are none, and the caller stores nothing: a build no shape was
// recorded for has nothing to be compared against, which is not the same as a
// build that removed nothing.
export async function servedShapes(
  db: Database,
  rec: {
    readonly clusterId: string;
    readonly database: string;
    readonly collection: string;
    readonly indexName: string;
  },
  now: Date,
): Promise<{ servedShapeDigests: string[]; baselineWeeklyDocsExamined: number } | null> {
  const rows = await db
    .select({
      digest: workloadShapes.shapeDigest,
      weeklyDocsExamined: workloadShapes.weeklyDocsExamined,
    })
    .from(workloadShapes)
    .where(
      and(
        eq(workloadShapes.clusterId, rec.clusterId),
        eq(workloadShapes.database, rec.database),
        eq(workloadShapes.collection, rec.collection),
        eq(workloadShapes.proposedIndex, rec.indexName),
        gte(workloadShapes.lastSeenAt, new Date(now.getTime() - OPEN_SCANS_WINDOW_DAYS * DAY_MS)),
      ),
    );
  if (rows.length === 0) return null;
  return {
    servedShapeDigests: rows.map((row) => row.digest),
    // An in-memory sort the source reported no examined count for adds nothing
    // here rather than a guess; it is still one of the shapes.
    baselineWeeklyDocsExamined: rows.reduce((sum, row) => sum + (row.weeklyDocsExamined ?? 0), 0),
  };
}
