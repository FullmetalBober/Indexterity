import {
  createScore,
  type IndexSpec,
  recommendCreates,
  type ScanSeverity,
  type SortKey,
  scanCost,
  sortOrderAdvisories,
} from "../analysis";
import { entitledAutomation } from "../billing/plans";
import { and, eq, inArray, indexCooldowns, like, or, policies, recommendations } from "../db";
import { type WorkloadTarget, workloadKey } from "../engine/ports";
import { openClusterSession } from "./cluster-connection";
import { activeCooldownKeys, cooldownKey } from "./cooldowns";
import { applyCreatesForCluster } from "./create";
import { jobDb } from "./db";
import { planForCluster } from "./plan";

// A shape must recur before it earns a recommendation — someone running a
// heavy ad-hoc query once or twice must not leave an index behind.
const WORKLOAD_OPTIONS = { minCount: 3 };
// A TTL advisory needs a RECURRING delete pattern, not a one-off cleanup.
const TTL_MIN_DELETES = 3;
// Below this a collection is too small for a scan to matter at all.
const MIN_COLLECTION_DOCS = 1000;
// Instant apply (build without human approval) demands stronger recurrence
// than merely proposing.
const INSTANT_MIN_COUNT = 5;

function proposedName(keys: readonly SortKey[]): string {
  return keys.map((key) => `${key.field}_${key.direction}`).join("_");
}

// targetSpec key encoding: plain = ascending, ":-1" suffix = descending.
function encodeKeys(keys: readonly SortKey[]): string[] {
  return keys.map((key) => (key.direction === -1 ? `${key.field}:-1` : key.field));
}

// Workload analysis (opt-in): read the profiler and propose CREATE/UPDATE/MERGE.
// A brand-new index on a critical collection, when instantCreate is opted in and
// the cluster is writable, is auto-approved and built immediately
// (creates only — never drops; docs/architecture.md §7.5).
export async function suggestForCluster(clusterId: string): Promise<number> {
  const db = jobDb();
  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.clusterId, clusterId))
    .limit(1);
  if (policy?.workloadAnalysis !== true) return 0;
  const cooled = await activeCooldownKeys(db, clusterId);
  // Full cooldown history — a previously rolled-back build cuts the score hard.
  const cooldownRows = await db
    .select()
    .from(indexCooldowns)
    .where(eq(indexCooldowns.clusterId, clusterId));
  const regressionCounts = new Map<string, number>();
  for (const row of cooldownRows) {
    regressionCounts.set(`${row.database} ${row.collection} ${row.indexName}`, row.regressionCount);
  }

  // Same as apply: obey the plan, not just the stored policy.
  const automation = entitledAutomation(
    { autoApplyScore: policy.autoApplyScore, instantCreate: policy.instantCreate },
    await planForCluster(db, clusterId),
  );

  const { session, readOnly, release } = await openClusterSession(db, clusterId);
  let created = 0;
  let instantApproved = 0;
  try {
    const collector = session.collector;
    const databases = await session.listDatabaseNames();
    const toInsert: Array<typeof recommendations.$inferInsert> = [];
    // Index lists already fetched this run, keyed "db\0coll" — reused when
    // resolving $lookup wants against foreign collections.
    const indexCache = new Map<string, IndexSpec[]>();
    // $lookup joins seen across all shapes: foreign collection + field -> count.
    const lookupWants = new Map<
      string,
      { database: string; from: string; foreignField: string; count: number }
    >();
    const namespaces: WorkloadTarget[] = [];
    for (const database of databases) {
      for (const collection of await collector.listCollectionNames(database)) {
        namespaces.push({ database, collection });
      }
    }
    for (const { database, collection } of namespaces) {
      // TTL advisories run BEFORE the size gate: a collection with recurring
      // age-based deletes is small BY DESIGN (it's being pruned). The app
      // already deletes by age — a TTL index would do it automatically.
      // Indexterity NEVER builds TTL indexes (they delete documents), so this
      // is advisory-only, excluded from every auto-approve path.
      const deletePatterns = await collector.collectDeletePatterns(database, collection);
      const ttlWorthy = deletePatterns.filter((pattern) => pattern.count >= TTL_MIN_DELETES);
      if (ttlWorthy.length > 0) {
        const currentIndexes = await collector.listIndexes(database, collection);
        for (const pattern of ttlWorthy) {
          if (currentIndexes.some((idx) => idx.ttl && idx.keys[0]?.field === pattern.field)) {
            continue;
          }
          const indexName = `${pattern.field}_1_ttl`;
          if (cooled.has(cooldownKey(database, collection, indexName))) continue;
          const days = Math.max(1, Math.round(pattern.medianRetentionSeconds / 86_400));
          toInsert.push({
            clusterId,
            type: "ADVISORY_REVIEW",
            state: "PROPOSED",
            database,
            collection,
            indexName,
            rationale:
              `Recurring age-based deletes on ${pattern.field} (${pattern.count}× in the profiler, ` +
              `retention ≈ ${days} days). A TTL index would expire documents automatically and ` +
              `steadily: db.${collection}.createIndex({ ${pattern.field}: 1 }, { expireAfterSeconds: ${pattern.medianRetentionSeconds} }). ` +
              `CAUTION: TTL deletes documents — verify the retention window and create it yourself; Indexterity never builds TTL indexes.`,
            score: Math.min(80, 30 + pattern.count * 10),
            estimatedBytesSaved: 0,
          });
        }
      }
    }

    // Which collections are worth create-side analysis at all. Settled before
    // the workload read so it can be asked for every namespace in one call —
    // the store it reads is cluster-wide, so asking per collection would pull
    // the whole thing once per collection.
    const eligible: Array<WorkloadTarget & { docCount: number }> = [];
    for (const { database, collection } of namespaces) {
      // Counts come from $collStats, not the count command — the scoped
      // least-privilege user has no `find` grant, which `count` requires.
      const { dataSizeBytes, docCount } = await collector.collectionStorage(database, collection);
      if (docCount < MIN_COLLECTION_DOCS) continue;
      // Policy ceiling: building an index on a huge collection is the one
      // expensive create-side operation — skip collections above the limit.
      if (policy.maxCollectionSizeBytes !== null && dataSizeBytes > policy.maxCollectionSizeBytes) {
        continue;
      }
      eligible.push({ database, collection, docCount });
    }
    const workload = await collector.collectWorkload(eligible);
    for (const { database, collection, docCount } of eligible) {
      const shapes = workload.get(workloadKey(database, collection)) ?? [];
      const [existing, sizes] = await Promise.all([
        collector.listIndexes(database, collection),
        collector.indexSizes(database, collection),
      ]);
      indexCache.set(`${database}\u0000${collection}`, existing);
      // Record $lookup joins for the post-loop foreign-side pass.
      for (const shape of shapes) {
        for (const join of shape.lookups ?? []) {
          const key = `${database}\u0000${join.from}\u0000${join.foreignField}`;
          const prev = lookupWants.get(key) ?? {
            database,
            from: join.from,
            foreignField: join.foreignField,
            count: 0,
          };
          prev.count += shape.count;
          lookupWants.set(key, prev);
        }
      }
      // A new index isn't free: estimate its size from this collection's
      // average existing index, and remind about the extra write per insert.
      const sizeValues = Object.values(sizes);
      const avgIndexBytes =
        sizeValues.length > 0
          ? sizeValues.reduce((sum, value) => sum + value, 0) / sizeValues.length
          : docCount * 16;
      const cost = ` Est. build ≈ ${Math.max(1, Math.round(avgIndexBytes / 1024))} KB (+1 write per doc write).`;
      // What this collection's scans are actually costing. The worst shape
      // decides: one query burning ten million document reads is the problem
      // whether or not the others are mild.
      const costs = shapes.map((shape) => scanCost(shape, docCount));
      const severity: ScanSeverity = costs.some((cost) => cost.severity === "CRITICAL")
        ? "CRITICAL"
        : costs.some((cost) => cost.severity === "ELEVATED")
          ? "ELEVATED"
          : "ROUTINE";
      const worst = costs.find((cost) => cost.severity === severity);

      // An index already covers the fields but in an order that cannot serve
      // the sort. No create is proposed for it — the fix is a second index
      // differing only in direction, which doubles this collection's write cost
      // and is a judgement call. Say so rather than drop it silently.
      for (const advisory of sortOrderAdvisories(shapes, existing, WORKLOAD_OPTIONS)) {
        const indexName = `${advisory.existingIndex}_sortorder`;
        if (cooled.has(cooldownKey(database, collection, indexName))) continue;
        const keys = advisory.wantedKeys.map((key) => `${key.field}: ${key.direction}`).join(", ");
        toInsert.push({
          clusterId,
          type: "ADVISORY_REVIEW",
          state: "PROPOSED",
          database,
          collection,
          indexName,
          rationale:
            `${advisory.existingIndex} covers these fields but not in an order that serves ` +
            `the sort, so the server orders the results in memory (seen ${advisory.count}×). ` +
            `An index on {${keys}} would serve it: db.${collection}.createIndex({ ${keys} }). ` +
            `CAUTION: that is a second index on the same fields — it doubles the write cost ` +
            `for this collection, so decide whether both are worth keeping before building it.`,
          score: Math.min(70, 25 + advisory.count * 5),
          estimatedBytesSaved: 0,
        });
      }

      for (const candidate of recommendCreates(shapes, existing, WORKLOAD_OPTIONS)) {
        // Partial variants get a suffix so they never collide with the full
        // index of the same keys.
        const indexName =
          proposedName(candidate.keys) + (candidate.partialFilter === undefined ? "" : "_partial");
        if (cooled.has(cooldownKey(database, collection, indexName))) continue;
        const score = createScore({
          collscan: candidate.scanning,
          sortedInMemory: !candidate.scanning,
          count: candidate.count,
          docCount,
          severity,
          pastRegressions: regressionCounts.get(`${database} ${collection} ${indexName}`) ?? 0,
        });
        // Severity is the collection's, not this candidate's, so a sort-driven
        // candidate must not inherit a different shape's scan as grounds for
        // building itself without being asked.
        const instant =
          candidate.type === "CREATE" &&
          candidate.scanning &&
          severity !== "ROUTINE" &&
          candidate.count >= INSTANT_MIN_COUNT &&
          automation.instantCreate &&
          !readOnly;
        if (instant) instantApproved += 1;
        // A CRITICAL scan is paid on every execution; waiting for the quiet
        // window can mean most of a day of it.
        const urgent = instant && severity === "CRITICAL";
        toInsert.push({
          clusterId,
          type: candidate.type,
          state: instant ? "APPROVED" : "PROPOSED",
          database,
          collection,
          indexName,
          rationale:
            (instant
              ? `${candidate.rationale} (auto-approved: ${severity.toLowerCase()} scan)`
              : candidate.rationale) +
            // Same reason: the cost figure describes the collection's scans, so
            // quoting it under a sort-driven candidate would misattribute it.
            (worst === undefined || !candidate.scanning ? "" : ` Cost: ${worst.summary}.`) +
            cost,
          score,
          estimatedBytesSaved: 0,
          urgent,
          targetSpec: {
            keys: encodeKeys(candidate.keys),
            retire: [...candidate.retireIndexes],
            ...(candidate.partialFilter === undefined
              ? {}
              : { partial: { ...candidate.partialFilter } }),
          },
        });
      }
    }
    // Foreign-side $lookup indexes: a join field with no leading index makes
    // every joined document scan the foreign collection.
    for (const want of lookupWants.values()) {
      const cacheKey = `${want.database}\u0000${want.from}`;
      let foreignIndexes = indexCache.get(cacheKey);
      if (foreignIndexes === undefined) {
        try {
          foreignIndexes = await collector.listIndexes(want.database, want.from);
        } catch {
          continue; // foreign collection gone — no signal
        }
        indexCache.set(cacheKey, foreignIndexes);
      }
      if (foreignIndexes.some((idx) => idx.keys[0]?.field === want.foreignField)) continue;
      // Same size gate as other creates — a tiny foreign collection scans cheaply.
      const { docCount: foreignDocs } = await collector.collectionStorage(want.database, want.from);
      if (foreignDocs < MIN_COLLECTION_DOCS) continue;
      const indexName = `${want.foreignField}_1`;
      if (cooled.has(cooldownKey(want.database, want.from, indexName))) continue;
      if (
        toInsert.some(
          (row) =>
            row.database === want.database &&
            row.collection === want.from &&
            row.indexName === indexName,
        )
      ) {
        continue;
      }
      toInsert.push({
        clusterId,
        type: "CREATE",
        state: "PROPOSED",
        database: want.database,
        collection: want.from,
        indexName,
        rationale:
          `$lookup joins ${want.database}.${want.from} on ${want.foreignField} ` +
          `(seen ${want.count}×) — without this index every joined document scans ${want.from}.`,
        score: createScore({
          collscan: true,
          count: want.count,
          docCount: foreignDocs,
          pastRegressions: regressionCounts.get(`${want.database} ${want.from} ${indexName}`) ?? 0,
        }),
        estimatedBytesSaved: 0,
        targetSpec: { keys: [want.foreignField], retire: [] },
      });
    }
    await db
      .delete(recommendations)
      .where(
        and(
          eq(recommendations.clusterId, clusterId),
          eq(recommendations.state, "PROPOSED"),
          or(
            inArray(recommendations.type, ["CREATE", "UPDATE", "MERGE"]),
            and(
              eq(recommendations.type, "ADVISORY_REVIEW"),
              or(
                like(recommendations.indexName, "%_ttl"),
                like(recommendations.indexName, "%_sortorder"),
              ),
            ),
          ),
        ),
      );
    if (toInsert.length > 0) await db.insert(recommendations).values(toInsert);
    created = toInsert.length;
  } finally {
    release();
  }
  // Build the auto-approved creates now rather than waiting for the scheduler.
  // Anything not marked urgent still waits for the change window inside.
  if (instantApproved > 0) await applyCreatesForCluster(clusterId);
  return created;
}
