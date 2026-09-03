import { cooldownDaysFor } from "../analysis/cooldown";
import { and, type Database, eq, gt, indexCooldowns, isNull, or } from "../db";

const DAY_MS = 86_400_000;

export interface CooldownTarget {
  readonly database: string;
  readonly collection: string;
  readonly indexName: string;
}

export function cooldownKey(database: string, collection: string, indexName: string): string {
  return `${database}\u0000${collection}\u0000${indexName}`;
}

// A cooldown on the COLLECTION rather than on one of its indexes (#282).
//
// The empty index name is a sentinel and it is chosen rather than tolerated: the
// table's unique key is (cluster, database, collection, index_name), which is
// already exactly the shape a collection-level park needs, and an index cannot be
// called "" on either engine — mongo refuses an empty index name and SQL Server's
// sysname is not nullable or empty — so the sentinel cannot collide with a real
// index. A separate table would have duplicated the escalation, the fade and the
// panel that draws them, for one row shape.
//
// It parks nothing by itself. `activeCooldownKeys` returns it like any other key
// and no index matches it; what reads it is suggest.ts, which declines to build
// UNATTENDED on a collection whose writes the last run of builds slowed.
export const WHOLE_COLLECTION = "";

export function collectionCooldownKey(database: string, collection: string): string {
  return cooldownKey(database, collection, WHOLE_COLLECTION);
}

export function isWholeCollection(indexName: string): boolean {
  return indexName === WHOLE_COLLECTION;
}

// The (database, collection, index) keys currently cooling down for a cluster —
// the engine skips proposing these so a regressed index isn't blindly re-cycled.
export async function activeCooldownKeys(db: Database, clusterId: string): Promise<Set<string>> {
  const rows = await db
    .select()
    .from(indexCooldowns)
    .where(
      and(
        eq(indexCooldowns.clusterId, clusterId),
        // A NULL `until` is forever: the owner said never touch this index again
        // (D136). Written as a null rather than a date far in the future, because
        // "never" is not a very long time — a sentinel date would eventually pass,
        // and the row would silently become eligible on a day nobody chose.
        or(isNull(indexCooldowns.until), gt(indexCooldowns.until, new Date())),
      ),
    );
  return new Set(rows.map((row) => cooldownKey(row.database, row.collection, row.indexName)));
}

// Un-park an index: the owner changed their mind, or the workload did.
//
// A DELETE and not an expiry backdated to now, which is the choice worth stating.
// `regression_count` lives on this row and feeds both the escalation above and
// the confidence score (analysis/score.ts), so backdating would leave the count
// in force: the index would be eligible again and still be carrying a score
// penalty for regressions the owner has just said to forget. Clearing means
// clearing.
export async function clearCooldown(
  db: Database,
  clusterId: string,
  target: CooldownTarget,
): Promise<boolean> {
  const removed = await db
    .delete(indexCooldowns)
    .where(
      and(
        eq(indexCooldowns.clusterId, clusterId),
        eq(indexCooldowns.database, target.database),
        eq(indexCooldowns.collection, target.collection),
        eq(indexCooldowns.indexName, target.indexName),
      ),
    )
    .returning({ id: indexCooldowns.id });
  return removed.length > 0;
}

// Park an index after a human cancelled its pending drop. Deliberately NOT a
// regression: `regressionCount` feeds the confidence score and the escalating
// backoff, and nothing regressed — someone simply knows something the engine
// does not. The cooldown exists so the next classify pass does not re-propose
// the same index straight back into the pipeline.
//
// `days` is the owner's answer and null means NEVER (D136). The engine proposes
// `proposedVetoDays` and the owner may take it, change it, or say never — which
// is the case the old flat 90 days had no way to express, so an owner who knew
// an index was load-bearing forever had to re-cancel its drop four times a year.
export async function recordManualVeto(
  db: Database,
  clusterId: string,
  target: CooldownTarget,
  days: number | null,
  reason: string,
): Promise<Date | null> {
  const until = days === null ? null : new Date(Date.now() + days * DAY_MS);
  await db
    .insert(indexCooldowns)
    .values({ clusterId, ...target, reason, regressionCount: 0, until })
    .onConflictDoUpdate({
      target: [
        indexCooldowns.clusterId,
        indexCooldowns.database,
        indexCooldowns.collection,
        indexCooldowns.indexName,
      ],
      // Keep whatever regression history exists; only push the date out.
      set: { reason, until, updatedAt: new Date() },
    });
  return until;
}

// Record a regression and escalate: the first parks the index for one observe
// window and each repeat doubles it, capped (see cooldownDaysFor). Returns
// `until`.
export async function recordRegression(
  db: Database,
  clusterId: string,
  target: CooldownTarget,
  observeDays: number,
  reason: string,
): Promise<Date> {
  const [existing] = await db
    .select()
    .from(indexCooldowns)
    .where(
      and(
        eq(indexCooldowns.clusterId, clusterId),
        eq(indexCooldowns.database, target.database),
        eq(indexCooldowns.collection, target.collection),
        eq(indexCooldowns.indexName, target.indexName),
      ),
    )
    .limit(1);
  const count = (existing?.regressionCount ?? 0) + 1;
  const until = new Date(Date.now() + cooldownDaysFor(observeDays, count) * DAY_MS);
  await db
    .insert(indexCooldowns)
    .values({ clusterId, ...target, reason, regressionCount: count, until })
    .onConflictDoUpdate({
      target: [
        indexCooldowns.clusterId,
        indexCooldowns.database,
        indexCooldowns.collection,
        indexCooldowns.indexName,
      ],
      set: { reason, regressionCount: count, until, updatedAt: new Date() },
    });
  return until;
}
