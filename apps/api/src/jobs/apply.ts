import { dynamicObserveDays, inChangeWindow } from "../analysis";
import {
  actions,
  and,
  type Database,
  eq,
  gte,
  indexSnapshots,
  ne,
  policies,
  recommendations,
} from "../db";
import { serializeSpec } from "../mongo";
import { effectiveChangeWindow } from "./change-window";
import { openClusterSession } from "./cluster-connection";
import { jobDb } from "./db";
import { preflightDrop } from "./preflight";

const DROP_TYPES = new Set(["DROP_UNUSED", "DROP_REDUNDANT", "MERGE"]);
const DEFAULT_OBSERVE_DAYS = 30;

// Auto-approval, the whole of it. One threshold, no companion switch: null
// means nothing is promoted and a human clicks, 0 means everything is,
// anything between is a confidence floor.
//
// ADVISORY_REVIEW is excluded at every setting. "A human should look at this"
// is the entire content of an advisory, and promoting one also strands it —
// classify only deletes and re-inserts PROPOSED rows, so an approved advisory
// leaves the refresh pool and is never re-evaluated again.
export async function promoteByScore(
  db: Database,
  clusterId: string,
  threshold: number | null,
): Promise<void> {
  if (threshold === null) return;
  await db
    .update(recommendations)
    .set({ state: "APPROVED", updatedAt: new Date() })
    .where(
      and(
        eq(recommendations.clusterId, clusterId),
        eq(recommendations.state, "PROPOSED"),
        gte(recommendations.score, threshold),
        ne(recommendations.type, "ADVISORY_REVIEW"),
      ),
    );
}

// APPROVED drops -> pre-flight -> hide (collMod hidden:true) -> HIDDEN. Hiding is
// instant and reversible; it starts the observe window. Records an audit action
// with a rollback token. A failed pre-flight re-proposes instead of hiding.
// Anything the threshold above promotes goes through the same gates as a drop
// a human approved by hand.
export async function applyCluster(clusterId: string): Promise<number> {
  const db = jobDb();
  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.clusterId, clusterId))
    .limit(1);
  await promoteByScore(db, clusterId, policy?.autoApplyScore ?? null);
  const approved = await db
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.clusterId, clusterId), eq(recommendations.state, "APPROVED")));
  if (approved.length === 0) return 0;
  // Hides are elective — they wait for the change window (the promotion above
  // is db-only and runs anytime). Recommendations stay APPROVED until a tick
  // lands inside the window.
  const window = effectiveChangeWindow({
    changeWindowStartHour: policy?.changeWindowStartHour ?? null,
    changeWindowEndHour: policy?.changeWindowEndHour ?? null,
    inferredWindowStartHour: policy?.inferredWindowStartHour ?? null,
    inferredWindowEndHour: policy?.inferredWindowEndHour ?? null,
  });
  if (!inChangeWindow(new Date(), window.startHour, window.endHour)) {
    return 0;
  }

  const { session, readOnly, release } = await openClusterSession(db, clusterId);
  try {
    // Read-only clusters never execute writes.
    if (readOnly) return 0;
    const collector = session.collector;
    const executor = session.executor(readOnly);
    let hidden = 0;
    for (const rec of approved) {
      if (!DROP_TYPES.has(rec.type)) continue;
      const check = await preflightDrop(collector, rec);
      if (!check.safe) {
        await db
          .update(recommendations)
          .set({ state: "PROPOSED", updatedAt: new Date() })
          .where(eq(recommendations.id, rec.id));
        await db.insert(actions).values({
          recommendationId: rec.id,
          kind: "HIDE",
          actor: "system",
          result: `aborted: ${check.reason}`,
        });
        continue;
      }
      await executor.hide(rec.database, rec.collection, rec.indexName);
      // Baseline read latency at hide time — the reference for regression checks.
      const baseline = await collector.readLatency(rec.database, rec.collection);
      // The observe window this index actually deserves, from its own usage
      // history: periodic usage extends it (a monthly job must get a chance to
      // run inside the window), long-proven idleness shortens it.
      const historyRows = await db
        .select()
        .from(indexSnapshots)
        .where(
          and(
            eq(indexSnapshots.clusterId, clusterId),
            eq(indexSnapshots.database, rec.database),
            eq(indexSnapshots.collection, rec.collection),
            eq(indexSnapshots.indexName, rec.indexName),
          ),
        );
      const window = dynamicObserveDays(
        historyRows.map((row) => ({
          capturedAt: row.capturedAt.toISOString(),
          ops: row.perMember.reduce((sum, member) => sum + member.ops, 0),
        })),
        policy?.observeWindowDays ?? DEFAULT_OBSERVE_DAYS,
      );
      await db
        .update(recommendations)
        .set({
          state: "HIDDEN",
          hiddenAt: new Date(),
          observeDays: window.days,
          baselineReadOps: baseline.ops,
          baselineReadLatency: baseline.latencyMicros,
          updatedAt: new Date(),
        })
        .where(eq(recommendations.id, rec.id));
      await db.insert(actions).values({
        recommendationId: rec.id,
        kind: "HIDE",
        actor: "system",
        result:
          window.reason === null
            ? `ok; observing ${window.days} days`
            : `ok; observing ${window.days} days — ${window.reason}`,
        rollbackToken: check.spec === null ? null : { spec: serializeSpec(check.spec) },
      });
      hidden += 1;
    }
    return hidden;
  } finally {
    release();
  }
}
