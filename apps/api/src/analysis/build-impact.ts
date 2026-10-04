// What a build did to the scanning it was for (#608).
//
// The record is taken when the index is built (jobs/served-shapes.ts): the
// scanning shapes it answers, by digest, and the documents they examined a week.
// Afterwards a shape the index serves is no longer a scanning shape, so the
// workload ledger stops writing it, and the shapes still being written are the
// ones the build did not fix. That is the only "after" there is — the ledger
// keeps no reading of a shape that stopped scanning, by design.

const HOUR_MS = 3_600_000;

// How long after a build before a shape still seen scanning counts against it. A
// day, because the profiler is a ring: scans from before the build stay in it
// until enough newer operations push them out, and on a quiet database that is
// hours. $queryStats has no such lag — one execution through the index and the
// shape stops reading as a scan — so the day only ever errs towards not yet
// having an answer.
export const SCANS_SETTLE_MS = 24 * HOUR_MS;

// A pass writes each database's shapes as it finishes that database, and its
// "read end to end" stamp only at the end. A pass that ended after the settle
// moment can therefore have written some shapes just before it; this is how
// long before still counts. An hour, against passes that take seconds to a few
// minutes.
const PASS_SLACK_MS = HOUR_MS;

export interface ServedShapesRecord {
  readonly database: string;
  readonly collection: string;
  readonly builtAt: Date;
  readonly servedShapeDigests: readonly string[] | null;
  readonly baselineWeeklyDocsExamined: number | null;
}

export interface SeenShape {
  readonly database: string;
  readonly collection: string;
  readonly digest: string;
  readonly weeklyDocsExamined: number | null;
  readonly lastSeenAt: Date;
}

export interface BuildScanReading {
  readonly shapes: number;
  readonly weeklyDocsExamined: number;
  readonly since: { readonly shapes: number; readonly weeklyDocsExamined: number } | null;
}

// Null for a build with nothing recorded. `since` is null until the workload has
// been read end to end after the settle moment (`workloadReadAt`): before that,
// a shape not seen is a shape not looked for.
export function scansFor(
  build: ServedShapesRecord,
  shapes: readonly SeenShape[],
  workloadReadAt: Date | null,
): BuildScanReading | null {
  const digests = build.servedShapeDigests;
  if (digests === null || digests.length === 0 || build.baselineWeeklyDocsExamined === null) {
    return null;
  }
  const settledAt = build.builtAt.getTime() + SCANS_SETTLE_MS;
  const judged = workloadReadAt !== null && workloadReadAt.getTime() >= settledAt;
  const wanted = new Set(digests);
  // Matched on the collection as well as the digest: a digest is of the shape
  // alone, and two collections can be scanned the same way.
  const still = shapes.filter(
    (shape) =>
      shape.database === build.database &&
      shape.collection === build.collection &&
      wanted.has(shape.digest) &&
      shape.lastSeenAt.getTime() >= settledAt - PASS_SLACK_MS,
  );
  return {
    shapes: wanted.size,
    weeklyDocsExamined: build.baselineWeeklyDocsExamined,
    since: judged
      ? {
          shapes: still.length,
          weeklyDocsExamined: still.reduce(
            (sum, shape) => sum + (shape.weeklyDocsExamined ?? 0),
            0,
          ),
        }
      : null,
  };
}
