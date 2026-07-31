import { and, type Database, eq, gt, indexCooldowns } from "../db";

const DAY_MS = 86_400_000;

export interface CooldownTarget {
  readonly database: string;
  readonly collection: string;
  readonly indexName: string;
}

export function cooldownKey(database: string, collection: string, indexName: string): string {
  return `${database}\u0000${collection}\u0000${indexName}`;
}

// The (database, collection, index) keys currently cooling down for a cluster —
// the engine skips proposing these so a regressed index isn't blindly re-cycled.
export async function activeCooldownKeys(db: Database, clusterId: string): Promise<Set<string>> {
  const rows = await db
    .select()
    .from(indexCooldowns)
    .where(and(eq(indexCooldowns.clusterId, clusterId), gt(indexCooldowns.until, new Date())));
  return new Set(rows.map((row) => cooldownKey(row.database, row.collection, row.indexName)));
}

// Park an index after a human cancelled its pending drop. Deliberately NOT a
// regression: `regressionCount` feeds the confidence score and the escalating
// backoff, and nothing regressed — someone simply knows something the engine
// does not. The cooldown exists so the next classify pass does not re-propose
// the same index straight back into the pipeline.
export async function recordManualVeto(
  db: Database,
  clusterId: string,
  target: CooldownTarget,
  days: number,
  reason: string,
): Promise<Date> {
  const until = new Date(Date.now() + days * DAY_MS);
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

// Record a regression and escalate: each repeat pushes the cooldown further out
// (base = 3x the observe window, linear in the regression count). Returns `until`.
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
  const until = new Date(Date.now() + observeDays * DAY_MS * 3 * count);
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
