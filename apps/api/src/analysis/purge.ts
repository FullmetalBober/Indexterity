import type { IndexSpec } from "../engine/types";

// What to SAY about a recurring age-based purge.
//
// The signal is engine-neutral and the advice is not (#206). Mongo has a
// mechanism that does the job for you, so the advisory names it. SQL Server has
// none — there is no TTL index — and repeating mongo's sentence there would be
// worse than saying nothing, because it recommends a thing that does not exist.
//
// What IS true on SQL Server is different and still worth a human's attention: a
// recurring age-based DELETE with no index on the date predicate scans the whole
// table and holds locks while it does, which is the workload that makes a table
// unavailable every night. The fix is an ordinary supporting index — the same
// thing the create side would propose from the same plan's own
// <MissingIndexes> hint — and above a certain size the better answer is not an
// index at all but a partitioned table with a sliding window, where retiring a
// month is a metadata operation instead of millions of row deletes.
//
// Advisory on BOTH engines, and for the same reason on neither: mongo's is
// advisory because a TTL index DELETES DATA and Indexterity never builds one;
// SQL Server's is advisory because "partition this table" is a schema change no
// index tool should make on its own. Same trust tier, different argument.

// Engines this has an opinion for. Anything else takes the mongo wording, which
// is also what a new adapter would want reviewed before it ships.
export type PurgeEngine = "MONGODB" | "POSTGRESQL" | "MSSQL";

export interface PurgePattern {
  readonly field: string;
  readonly count: number;
  readonly medianRetentionSeconds: number | null;
}

export interface PurgeAdvisory {
  // The recommendation row's name slot. Suffixed so it can never collide with
  // a real index, or with the create side's own proposal for the same column —
  // those are different findings and both may be worth having.
  readonly indexName: string;
  readonly rationale: string;
}

// Rows above which a partitioned sliding window is the honest recommendation
// rather than a footnote. Deliberately not a hard rule: partitioning is a
// schema change with real consequences, so the number decides how PROMINENTLY
// it is mentioned, never whether anything happens.
const PARTITION_WORTH_MENTIONING_ROWS = 10_000_000;

function retentionPhrase(seconds: number | null): string {
  if (seconds === null) {
    // A parameterised cutoff. Saying "retention ≈ 1 day" from a missing number
    // would be worse than admitting the store does not carry it.
    return "the retention window is not visible in the plan (the cutoff is a parameter)";
  }
  const days = Math.max(1, Math.round(seconds / 86_400));
  return `retention ≈ ${days} day${days === 1 ? "" : "s"}`;
}

// Does an existing index already answer this purge's predicate? Leading key
// only: a purge filters on the date and nothing else, so an index that merely
// CONTAINS the column somewhere down its key list will not be seeked.
export function purgeIsSupported(field: string, indexes: readonly IndexSpec[]): boolean {
  return indexes.some((index) => index.keys[0]?.field === field && !index.hidden);
}

// Null when there is nothing worth saying — which on SQL Server is the case
// where the purge is already indexed and the table is small enough that
// partitioning would be over-engineering.
export function purgeAdvisory(
  engine: PurgeEngine,
  pattern: PurgePattern,
  collection: string,
  indexes: readonly IndexSpec[],
  rowCount: number,
): PurgeAdvisory | null {
  if (engine !== "MSSQL") {
    // Mongo: a TTL index already on the field means the mechanism is in place.
    if (indexes.some((index) => index.ttl && index.keys[0]?.field === pattern.field)) return null;
    const seconds = pattern.medianRetentionSeconds;
    const expire =
      seconds === null
        ? `db.${collection}.createIndex({ ${pattern.field}: 1 }, { expireAfterSeconds: <your window in seconds> })`
        : `db.${collection}.createIndex({ ${pattern.field}: 1 }, { expireAfterSeconds: ${seconds} })`;
    return {
      indexName: `${pattern.field}_1_ttl`,
      rationale:
        `Recurring age-based deletes on ${pattern.field} (${pattern.count}× in the profiler, ` +
        `${retentionPhrase(seconds)}). A TTL index would expire documents automatically and ` +
        `steadily: ${expire}. ` +
        `CAUTION: TTL deletes documents — verify the retention window and create it yourself; ` +
        `Indexterity never builds TTL indexes.`,
    };
  }

  const supported = purgeIsSupported(pattern.field, indexes);
  const large = rowCount >= PARTITION_WORTH_MENTIONING_ROWS;
  // Indexed and small: the purge is doing the right thing already, and there is
  // no advice left that is not just noise on a screen.
  if (supported && !large) return null;

  const opening =
    `Recurring age-based deletes on ${pattern.field} (${pattern.count} executions in Query ` +
    `Store, ${retentionPhrase(pattern.medianRetentionSeconds)}). SQL Server has no TTL index, ` +
    `so this pattern stays your job — but two things make it much cheaper.`;
  const indexAdvice = supported
    ? `The predicate is already indexed, so the delete seeks rather than scans.`
    : `There is no index leading with ${pattern.field}, so each run SCANS ${collection} and ` +
      `holds locks for the whole pass — this is the job that makes a table unavailable at ` +
      `night. A nonclustered index on (${pattern.field}) turns the scan into a range seek.`;
  const partitionAdvice = large
    ? `At ${Math.round(rowCount / 1_000_000)}M rows the better answer is not an index at all: ` +
      `partition ${collection} on ${pattern.field} and retire whole partitions with a SLIDING ` +
      `WINDOW (SWITCH OUT, then drop), which retires a period as a metadata operation instead ` +
      `of millions of logged row deletes.`
    : `If this table grows into the tens of millions of rows, partitioning it on ` +
      `${pattern.field} and retiring whole partitions with a sliding window replaces the delete ` +
      `entirely — worth remembering before it gets there.`;
  return {
    indexName: `${pattern.field}_1_purge`,
    rationale:
      `${opening} ${indexAdvice} ${partitionAdvice} ` +
      `Advisory only: Indexterity never changes a table's partitioning, and never writes the ` +
      `purge job itself.`,
  };
}
