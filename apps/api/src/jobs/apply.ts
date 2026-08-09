import { dynamicObserveDays, inChangeWindow } from "../analysis";
import { runFrom } from "../analysis/types";
import { entitledAutomation } from "../billing/plans";
import {
  actions,
  and,
  clusterIndexes,
  type Database,
  eq,
  gte,
  indexSnapshots,
  notInArray,
  policies,
  recommendations,
  sql,
} from "../db";
import { emitClusterEvent } from "../events/emit";
import { serializeSpec } from "../mongo";
import { effectiveChangeWindow } from "./change-window";
import { openClusterSession } from "./cluster-connection";
import { jobDb } from "./db";
import { historyWindow, planForCluster } from "./plan";
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
//
// REORDER is excluded for a different reason, and deliberately rather than by
// scoring it low. It rebuilds a UNIQUE index with different key directions —
// provably the same constraint, built before the original is retired, so
// nothing is ever unenforced — but a change to a constraint-bearing index is a
// different felt risk from adding one, and this is where that decision is
// enforced rather than left to a threshold somebody may set to 0.
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
        notInArray(recommendations.type, ["ADVISORY_REVIEW", "REORDER"]),
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
  // What the plan permits, not merely what was saved: a downgrade must stop the
  // engine approving on its own, without discarding the score the owner chose.
  const automation = entitledAutomation(
    {
      autoApplyScore: policy?.autoApplyScore ?? null,
      instantCreate: policy?.instantCreate ?? false,
    },
    await planForCluster(db, clusterId),
  );
  await promoteByScore(db, clusterId, automation.autoApplyScore);
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

  // When collection for this cluster began. An index first seen well after
  // that appeared on our watch, so its age is knowable; one present from the
  // start could be any age at all.
  //
  // Read off the DIMENSION table, not the time series. A dimension row is created
  // the first time an index is seen in a shape, so its min(created_at) is the same
  // instant the old min(captured_at) found — over one row per index rather than one
  // per index per collect, and covered by cluster_indexes_cluster. The snapshot
  // table's own index leads with last_seen_at now, so the old query would have
  // become a full scan of the cluster's history on every tick inside the window.
  const [watch] = await db
    .select({ since: sql<Date | null>`min(${clusterIndexes.createdAt})` })
    .from(clusterIndexes)
    .where(eq(clusterIndexes.clusterId, clusterId));
  const watchingSince = watch?.since == null ? null : new Date(watch.since).toISOString();
  const since = await historyWindow(db, clusterId);

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
        .select({
          capturedAt: indexSnapshots.capturedAt,
          lastSeenAt: indexSnapshots.lastSeenAt,
          observations: indexSnapshots.observations,
          maxGapMs: indexSnapshots.maxGapMs,
          perMember: indexSnapshots.perMember,
        })
        .from(indexSnapshots)
        .innerJoin(clusterIndexes, eq(indexSnapshots.indexId, clusterIndexes.id))
        .where(
          and(
            eq(indexSnapshots.clusterId, clusterId),
            // Every cluster_indexes index leads with cluster_id, so without this
            // the namespace predicates cannot use one and each recommendation in
            // the loop costs a scan of the whole dimension table.
            eq(clusterIndexes.clusterId, clusterId),
            eq(clusterIndexes.database, rec.database),
            eq(clusterIndexes.collection, rec.collection),
            eq(clusterIndexes.indexName, rec.indexName),
            // The plan's window, applied here rather than by deletion — the observe
            // length is derived from this history, so an org must not get a window
            // sized on evidence it is not entitled to.
            gte(indexSnapshots.lastSeenAt, since),
          ),
        );
      const window = dynamicObserveDays(
        historyRows.map((row) => ({
          ...runFrom(row),
          ops: row.perMember.reduce((sum, member) => sum + member.ops, 0),
        })),
        policy?.observeWindowDays ?? DEFAULT_OBSERVE_DAYS,
        { watchingSince, now: new Date() },
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
      // At the transition, not at the end of the pass: a pass hiding several
      // indexes can hold a dashboard's stale row for the length of the loop.
      await emitClusterEvent(db, { clusterId, kind: "DROP_HIDDEN", task: null });
      hidden += 1;
    }
    return hidden;
  } finally {
    release();
  }
}
