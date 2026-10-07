import { inChangeWindow, notWorthBuilding } from "../analysis";
import type { Database } from "../db";
import { actions, and, eq, inArray, policies, recommendations } from "../db";
import { type IndexBuildOutcome, IndexBuildRefusedError } from "../engine/ports";
import type { IndexSpec } from "../engine/types";
import type { TunnelRegistry } from "../tunnel/tunnel.registry";
import { effectiveChangeWindow } from "./change-window";
import { openClusterSession } from "./cluster-connection";
import { servedShapes } from "./served-shapes";

// APPROVED CREATE/UPDATE/MERGE -> build the index (executor.create) -> ACTIVE.
// Retiring superseded indexes is left to the next classify pass, which sees them
// as DROP_REDUNDANT and routes them through the safe hide -> observe -> drop path.
// At build time the collection's write latency is recorded as the baseline for
// the post-build regression watch (finalize drops the index if writes regress).
export async function applyCreatesForCluster(
  db: Database,
  clusterId: string,
  // The live tunnels, when this cluster is reached over one (#353).
  // Optional because most callers have none and every cluster before
  // #353 needs none; a cluster WITH a tunnel_id and no registry is
  // refused rather than dialled directly.
  tunnels?: TunnelRegistry,
): Promise<number> {
  const approved = await db
    .select()
    .from(recommendations)
    .where(
      and(
        eq(recommendations.clusterId, clusterId),
        eq(recommendations.state, "APPROVED"),
        inArray(recommendations.type, ["CREATE", "UPDATE", "MERGE", "REORDER"]),
      ),
    );
  if (approved.length === 0) return 0;
  // Builds are elective and can spike load — they wait for the change window.
  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.clusterId, clusterId))
    .limit(1);
  const window = effectiveChangeWindow({
    changeWindowStartHour: policy?.changeWindowStartHour ?? null,
    changeWindowEndHour: policy?.changeWindowEndHour ?? null,
    inferredWindowStartHour: policy?.inferredWindowStartHour ?? null,
    inferredWindowEndHour: policy?.inferredWindowEndHour ?? null,
  });
  // Urgent builds answer a scan that is costing on every execution, so they do
  // not wait — the window exists to avoid adding load at a bad moment, and a
  // CRITICAL scan is already worse than the build. Everything else waits.
  const open = inChangeWindow(new Date(), window.startHour, window.endHour);
  const buildable = open ? approved : approved.filter((rec) => rec.urgent);
  if (buildable.length === 0) return 0;

  const { session, readOnly, release } = await openClusterSession(db, clusterId, { tunnels });
  try {
    if (readOnly) return 0;
    const collector = session.collector;
    const executor = session.executor(readOnly);
    let built = 0;
    for (const rec of buildable) {
      const target = rec.targetSpec;
      if (target === null || target.keys.length === 0) continue;
      // targetSpec keys encode direction as a ":-1" suffix ("at:-1"); plain
      // entries are ascending. Older rows are plain-ascending and still parse.
      const keys: Record<string, 1 | -1> = {};
      for (const entry of target.keys) {
        if (entry.endsWith(":-1")) keys[entry.slice(0, -3)] = -1;
        else keys[entry] = 1;
      }
      // A REORDER replaces a PROTECTED index, so it has to arrive carrying that
      // index's options — unique, the partial filter, sparse, the collation.
      // Refused rather than built without them: an index that was unique and
      // comes back not unique is a constraint silently removed, and it would be
      // removed for good the moment the original is retired.
      if (rec.type === "REORDER" && target.options === undefined) {
        await db.insert(actions).values({
          recommendationId: rec.id,
          kind: "CREATE",
          actor: "system",
          result: "refused: no original options recorded, so the replacement could not match it",
        });
        continue;
      }
      const carried = target.options;
      // What the table carries NOW, read before the build rather than learned
      // from its failure (#612). A build whose name is taken fails on every
      // engine but MongoDB, where an identical index is a silent success that
      // would then be recorded as ours — and a failure here is not one this pass
      // handles per row, so on the hosted deployment's SQL Server it stopped
      // every approved build on the cluster behind it for days. And an index an
      // existing one already serves is one classify would propose dropping the
      // moment it existed. Either way there is nothing to build, so the row
      // closes with the reason and the next build goes ahead.
      const unbuilt = notWorthBuilding(
        specOf(rec.indexName, keys, target),
        await collector.listIndexes(rec.database, rec.collection),
      );
      if (unbuilt !== null) {
        await closeUnbuilt(db, rec, `not built: ${unbuilt}`, `not built: ${unbuilt}`);
        continue;
      }
      let outcome: IndexBuildOutcome;
      try {
        outcome = await executor.create(rec.database, rec.collection, keys, {
          name: rec.indexName,
          ...(target.partial === undefined ? {} : { partialFilterExpression: target.partial }),
          ...(carried === undefined
            ? {}
            : {
                ...(carried.unique ? { unique: true } : {}),
                ...(carried.sparse ? { sparse: true } : {}),
                ...(carried.collation === null ? {} : { collation: { locale: carried.collation } }),
                ...(carried.partialFilter === undefined
                  ? {}
                  : { partialFilterExpression: carried.partialFilter }),
                ...(carried.include === undefined || carried.include.length === 0
                  ? {}
                  : { include: carried.include }),
              }),
        });
      } catch (error) {
        // The adapter will not build this specification — today, a partial
        // filter it cannot translate (#452). Not a version and not a transient
        // failure, so neither blocking the cluster nor retrying is right; and
        // not a proposal either, because approving it again would only be
        // refused again, which makes PROPOSED an approve button that leads
        // nowhere. So the row closes as REJECTED with the refusal in its
        // rationale and its history, and the pass goes on to the next build
        // rather than stalling every approved build on the cluster behind this
        // one. A row like it is not proposed again: the recommender now asks
        // the engine's capabilities before deriving a partial candidate.
        // Anything else thrown here still fails the pass, as before.
        if (!(error instanceof IndexBuildRefusedError)) throw error;
        await closeUnbuilt(
          db,
          rec,
          `refused by the engine: ${error.message}`,
          `refused: ${error.message}`,
        );
        continue;
      }
      // A scheduled build does not exist yet (#332). PostgreSQL's pg_cron route
      // returns as soon as the job is registered and the index appears minutes
      // later in a background worker, so ACTIVE here would claim a finished
      // build — and the write-latency baseline taken beside it would be measured
      // on a table the index is not on, which is the reference the post-build
      // regression watch then compares against. BUILDING says what is true, and
      // jobs/building.ts finishes the row when the index reports itself valid.
      if (outcome === "SCHEDULED") {
        await db
          .update(recommendations)
          .set({ state: "BUILDING", updatedAt: new Date() })
          .where(eq(recommendations.id, rec.id));
        await db.insert(actions).values({
          recommendationId: rec.id,
          kind: "CREATE",
          actor: "system",
          result: "scheduled: the build runs on the cluster and a later tick records the result",
        });
        built += 1;
        continue;
      }
      // Write-latency baseline at build time — the reference for the post-build watch.
      const { writes } = await collector.collectionLatency(rec.database, rec.collection);
      const builtAt = new Date();
      await db
        .update(recommendations)
        .set({
          state: "ACTIVE",
          builtAt,
          baselineWriteOps: writes.ops,
          baselineWriteLatency: writes.latencyMicros,
          ...(await servedShapes(db, rec, builtAt)),
          updatedAt: new Date(),
        })
        .where(eq(recommendations.id, rec.id));
      await db.insert(actions).values({
        recommendationId: rec.id,
        kind: "CREATE",
        actor: "system",
        result: "ok",
        rollbackToken: { indexName: rec.indexName },
      });
      built += 1;
    }
    return built;
  } finally {
    release();
  }
}

// The index a build would create, as the collector would read it back, so the
// redundancy rules can hold it against what the table already carries.
function specOf(
  name: string,
  keys: Record<string, 1 | -1>,
  target: { partial?: Record<string, unknown>; options?: BuildOptions },
): IndexSpec {
  const carried = target.options;
  const filter = target.partial ?? carried?.partialFilter;
  return {
    name,
    keys: Object.entries(keys).map(([field, direction]) => ({ field, direction })),
    unique: carried?.unique ?? false,
    ttl: false,
    partial: filter !== undefined,
    partialFilter: filter ?? null,
    sparse: carried?.sparse ?? false,
    hidden: false,
    isShardKey: false,
    collation: carried?.collation ?? null,
    ...(carried?.include === undefined ? {} : { include: carried.include }),
  };
}

type BuildOptions = {
  unique: boolean;
  sparse: boolean;
  collation: string | null;
  partialFilter?: Record<string, unknown>;
  include?: string[];
};

// A build that will not happen, closed with the reason where the owner reads the
// row and in its history. REJECTED, as #452 settled for a refusal: left APPROVED
// it is a retry that can only end the same way, and PROPOSED an approve button
// that leads nowhere.
async function closeUnbuilt(
  db: Database,
  rec: { readonly id: string; readonly rationale: string },
  why: string,
  result: string,
): Promise<void> {
  await db
    .update(recommendations)
    .set({ state: "REJECTED", rationale: `${rec.rationale} — ${why}`, updatedAt: new Date() })
    .where(eq(recommendations.id, rec.id));
  await db.insert(actions).values({
    recommendationId: rec.id,
    kind: "CREATE",
    actor: "system",
    result,
  });
}
