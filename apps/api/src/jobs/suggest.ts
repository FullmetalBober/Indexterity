import {
  createScore,
  crowdingPenalty,
  DEFAULT_OBSERVE_DAYS,
  executionsPerWeek,
  type IndexSpec,
  isRecurring,
  isReorderable,
  MIN_WEEKLY_DOCS_EXAMINED,
  narrowScore,
  purgeAdvisory,
  recommendCreates,
  recommendNarrowing,
  recommendReorder,
  regressionWeight,
  reorderScore,
  type ScanSeverity,
  type SortKey,
  scanCost,
  sortOrderAdvisories,
  weeklyScanCost,
} from "../analysis";
import { entitledAutomation } from "../billing/plans";
import type { Database } from "../db";
import { analysisNotes, and, eq, indexCooldowns, policies, recommendations } from "../db";
import { DatabaseInaccessibleError, type WorkloadTarget, workloadKey } from "../engine/ports";
import { openClusterSession } from "./cluster-connection";
import {
  collectionIndexesAfterBuild,
  pendingBuildsByCollection,
  wouldBuildUnattended,
} from "./collection-budget";
import { activeCooldownKeys, collectionCooldownKey, cooldownKey } from "./cooldowns";
import { applyCreatesForCluster } from "./create";
import { planForCluster } from "./plan";
import { BUILD_TYPES, standingRecommendationKeys, watchKey } from "./watched";

// A shape must recur before it earns a recommendation, measured two ways.
//
// The count stops someone's ad-hoc query leaving an index behind. The rate
// stops the far quieter mistake: `$queryStats` accumulates for the life of the
// store, so on a server up for two months, three executions clears a count
// floor while describing a query that runs roughly never. Fortnightly is the
// line — loose enough for a weekly report, which is a real workload pattern
// worth an index, and tight enough that a handful of runs since March is not.
const WORKLOAD_OPTIONS = { minCount: 3, minPerWeek: 0.5 };
// A TTL advisory needs a RECURRING delete pattern, not a one-off cleanup.
const TTL_MIN_DELETES = 3;
// Below this a collection is trivial whatever it costs: a scan of it is a page
// or two the server is holding anyway, and the index would cost more in write
// amplification than the scan ever costs to run. It is a floor, not a measure —
// everything above it is decided by MIN_WEEKLY_DOCS_EXAMINED, which knows what
// the scanning actually costs.
const TRIVIAL_COLLECTION_DOCS = 100;
// Instant apply (build without human approval) demands stronger recurrence
// than merely proposing.
const INSTANT_MIN_COUNT = 5;
// Narrowing an index means rebuilding it, which costs real IO on a large
// collection. Below this much reclaimed it is a net loss however sound the
// reasoning — the churn buys nothing.
const NARROW_MIN_SAVING_BYTES = 32 * 1024 * 1024;

function proposedName(keys: readonly SortKey[]): string {
  return keys.map((key) => `${key.field}_${key.direction}`).join("_");
}

// targetSpec key encoding: plain = ascending, ":-1" suffix = descending.
function encodeKeys(keys: readonly SortKey[]): string[] {
  return keys.map((key) => (key.direction === -1 ? `${key.field}:-1` : key.field));
}

// Workload analysis (on unless turned off): read the profiler and propose
// CREATE/UPDATE/MERGE. A brand-new index on a critical collection, when
// instantCreate is opted in and the cluster is writable, is auto-approved and
// built immediately (creates only — never drops; the wiki's Architecture page,
// Apply pipeline).
export async function suggestForCluster(db: Database, clusterId: string): Promise<number> {
  const [policy] = await db
    .select()
    .from(policies)
    .where(eq(policies.clusterId, clusterId))
    .limit(1);
  // Off only when a row says so. A MISSING row is not a decision — and it is the
  // normal state of a new cluster, because nothing creates a policy row at
  // onboarding: the first collect's inferred window does, or the owner saving
  // the form. Reading absence as "off" is what kept this silent on exactly the
  // clusters it had the most to say about (#258).
  if (policy?.workloadAnalysis === false) return 0;
  const cooled = await activeCooldownKeys(db, clusterId);
  // Builds already on the record in a state the sweep below does not clear —
  // approved and waiting for the change window, or proposed by another
  // producer. The index does not exist yet, so `existing` cannot stand in for
  // this check: without it the same build is proposed a second time beside the
  // one the customer already approved (see standingRecommendationKeys).
  const standing = await standingRecommendationKeys(db, clusterId, BUILD_TYPES, "WORKLOAD");
  // How many net-new builds each collection is already absorbing (#281). Read
  // once for the cluster and then incremented in memory as this pass proposes,
  // so the second create for one collection is scored against the first rather
  // than against the state both were derived from.
  const pendingBuilds = await pendingBuildsByCollection(db, clusterId);
  // Builds this pass declined to approve UNATTENDED because the collection is
  // already crowded. Nothing is suppressed — every one of them is proposed and
  // on screen — but "the engine chose not to do this by itself" is a decision,
  // and #277 is the surface for saying so.
  let heldFromInstant = 0;
  // Full cooldown history — a previously rolled-back build cuts the score hard.
  const cooldownRows = await db
    .select()
    .from(indexCooldowns)
    .where(eq(indexCooldowns.clusterId, clusterId));
  // Decayed, not raw — see analysis/score.ts. A regression counts in full while
  // the cooldown it bought is running and fades over the same span again, so a
  // build rolled back a year ago against a workload since rewritten no longer
  // disqualifies the index for the life of the cluster.
  const observeDays = policy?.observeWindowDays ?? DEFAULT_OBSERVE_DAYS;
  const regressionWeights = new Map<string, number>();
  for (const row of cooldownRows) {
    regressionWeights.set(
      `${row.database} ${row.collection} ${row.indexName}`,
      regressionWeight(row, observeDays),
    );
  }

  // Same as apply: obey the plan, not just the stored policy. Each fallback is
  // the column's own default, because a cluster with no row is a cluster nobody
  // has configured — never the one where automation should be assumed.
  const automation = entitledAutomation(
    {
      autoApplyScore: policy?.autoApplyScore ?? null,
      instantCreate: policy?.instantCreate ?? false,
    },
    await planForCluster(db, clusterId),
  );

  const { session, engine, readOnly, release } = await openClusterSession(db, clusterId);
  let created = 0;
  let instantApproved = 0;
  try {
    const collector = session.collector;
    const databases = await session.listDatabaseNames();
    const toInsert: Array<typeof recommendations.$inferInsert> = [];
    // Index lists already fetched this run, keyed "db\0coll" — reused when
    // resolving $lookup wants against foreign collections.
    const indexCache = new Map<string, IndexSpec[]>();
    // $lookup joins seen across all shapes: foreign collection + field -> how
    // often the join runs, as a raw count for the rationale and as a rate for
    // the cost gate.
    const lookupWants = new Map<
      string,
      { database: string; from: string; foreignField: string; count: number; perWeek: number }
    >();
    const namespaces: WorkloadTarget[] = [];
    for (const database of databases) {
      // Same rule as the collect pass (mongo/snapshots.ts): a database these
      // credentials cannot reach is skipped, and every other failure still aborts.
      try {
        for (const collection of await collector.listCollectionNames(database)) {
          namespaces.push({ database, collection });
        }
      } catch (error) {
        if (!(error instanceof DatabaseInaccessibleError)) throw error;
      }
    }
    for (const { database, collection } of namespaces) {
      // Purge advisories run BEFORE the size gate: a collection with recurring
      // age-based deletes is small BY DESIGN (it's being pruned).
      //
      // Advisory-only on both engines, and for different reasons — mongo's
      // recommendation is a TTL index, which DELETES DOCUMENTS and Indexterity
      // never builds one; SQL Server has no TTL index at all, and what it
      // recommends instead is an ordinary supporting index plus, on a large
      // table, a partitioned sliding window, which is a schema change no index
      // tool should make on its own. analysis/purge.ts holds both wordings.
      const deletePatterns = await collector.collectDeletePatterns(database, collection);
      const purgeWorthy = deletePatterns.filter((pattern) => pattern.count >= TTL_MIN_DELETES);
      if (purgeWorthy.length > 0) {
        const currentIndexes = await collector.listIndexes(database, collection);
        // Only read for the partition threshold, and only when there is a
        // pattern to judge — this is inside the loop over every namespace.
        const { docCount } = await collector
          .collectionStorage(database, collection)
          .catch(() => ({ docCount: 0, dataSizeBytes: 0 }));
        for (const pattern of purgeWorthy) {
          const advisory = purgeAdvisory(engine, pattern, collection, currentIndexes, docCount);
          if (advisory === null) continue;
          if (cooled.has(cooldownKey(database, collection, advisory.indexName))) continue;
          toInsert.push({
            clusterId,
            type: "ADVISORY_REVIEW",
            state: "PROPOSED",
            source: "WORKLOAD",
            database,
            collection,
            indexName: advisory.indexName,
            rationale: advisory.rationale,
            score: Math.min(80, 30 + pattern.count * 10),
            estimatedBytesSaved: 0,
          });
        }
      }
    }

    // Which collections to READ a workload for. Settled before the workload
    // read so it can be asked for every namespace in one call — the store it
    // reads is cluster-wide, so asking per collection would pull the whole
    // thing once per collection.
    //
    // Only what is knowable this early belongs here. Whether the queries are
    // worth acting on is a question about the queries, so it waits until they
    // have been read.
    const eligible: Array<WorkloadTarget & { docCount: number }> = [];
    for (const { database, collection } of namespaces) {
      // Counts come from $collStats, not the count command — the scoped
      // least-privilege user has no `find` grant, which `count` requires.
      const { dataSizeBytes, docCount } = await collector.collectionStorage(database, collection);
      if (docCount < TRIVIAL_COLLECTION_DOCS) continue;
      // Policy ceiling: building an index on a huge collection is the one
      // expensive create-side operation — skip collections above the limit.
      const sizeCeiling = policy?.maxCollectionSizeBytes ?? null;
      if (sizeCeiling !== null && dataSizeBytes > sizeCeiling) continue;
      eligible.push({ database, collection, docCount });
    }
    const workload = await collector.collectWorkload(eligible);
    for (const { database, collection, docCount } of eligible) {
      const shapes = workload.get(workloadKey(database, collection)) ?? [];
      // Record $lookup joins for the post-loop foreign-side pass. Ahead of the
      // cost gate below: what a join costs is the FOREIGN collection's business,
      // and a collection nothing scans itself can still drive an expensive one.
      for (const shape of shapes) {
        for (const join of shape.lookups ?? []) {
          const key = `${database}\u0000${join.from}\u0000${join.foreignField}`;
          const prev = lookupWants.get(key) ?? {
            database,
            from: join.from,
            foreignField: join.foreignField,
            count: 0,
            perWeek: 0,
          };
          prev.count += shape.count;
          prev.perWeek += executionsPerWeek(shape);
          lookupWants.set(key, prev);
        }
      }
      // Cost, not size: a collection earns create-side analysis by what its
      // scanning actually burns per week. This sits here and not up in the
      // eligibility pass because the eligibility pass runs before the workload
      // is known, where the only thing left to gate on is a document count —
      // which answers a different question and gets both directions wrong.
      //
      // A blocking sort is the exception. It walks no extra documents and still
      // ends in an error at 100 MB, so scan cost must not be what excludes it.
      const weeklyScan = weeklyScanCost(shapes, docCount);
      const blockingSort = shapes.some(
        (shape) => shape.sortedInMemory === true && isRecurring(shape, WORKLOAD_OPTIONS),
      );
      if (weeklyScan < MIN_WEEKLY_DOCS_EXAMINED && !blockingSort) continue;
      const [existing, sizes] = await Promise.all([
        collector.listIndexes(database, collection),
        collector.indexSizes(database, collection),
      ]);
      indexCache.set(`${database}\u0000${collection}`, existing);
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

      // A protected compound index whose directions cannot serve a sort the
      // workload performs. Rebuilt with the same keys in the same order and
      // different directions, which preserves a unique constraint exactly
      // (analysis/reorder.ts) — but only where nothing pins it with hint().
      //
      // The hint is a HARD VETO here, not a scoring penalty, and it is the one
      // veto that needs live state. `.hint("a_1_b_1")` against an index that is
      // now `a_1_b_-1` is an ERROR, not a slower query, and the default name
      // encodes the directions — so a hinted index breaks by name as well as by
      // key pattern. Nothing downstream would catch it either: the post-build
      // watch measures WRITE latency, and the queries in question would already
      // have stopped running.
      const hinted = existing.some((idx) => isReorderable(idx))
        ? new Set(await collector.collectHintedIndexes(database, collection))
        : new Set<string>();
      const reordering = new Set<string>();
      for (const candidate of recommendReorder(shapes, existing, WORKLOAD_OPTIONS, hinted)) {
        const indexName = proposedName(candidate.keys);
        if (cooled.has(cooldownKey(database, collection, indexName))) continue;
        if (standing.has(watchKey(database, collection, indexName))) continue;
        if (existing.some((idx) => idx.name === indexName)) continue;
        if (toInsert.some((row) => row.collection === collection && row.indexName === indexName)) {
          continue;
        }
        toInsert.push({
          clusterId,
          type: "REORDER",
          // Never APPROVED here, whatever the score: this class is
          // approval-only (jobs/apply.ts).
          state: "PROPOSED",
          source: "WORKLOAD",
          database,
          collection,
          indexName,
          rationale: `${candidate.rationale}${cost}`,
          score: reorderScore({
            count: candidate.count,
            sizeBytes: sizes[candidate.indexName] ?? 0,
            regressionWeight: regressionWeights.get(`${database} ${collection} ${indexName}`) ?? 0,
          }),
          // Claimed at retirement, not now: the original is still there and
          // still costing until it is actually dropped. A re-order reclaims
          // nothing anyway — the replacement is the same size.
          estimatedBytesSaved: 0,
          targetSpec: {
            keys: encodeKeys(candidate.keys),
            retire: [candidate.indexName],
            // Carried VERBATIM. A dropped option here is a silently weakened
            // constraint, which is the one outcome this feature must never
            // produce — so they travel with the row rather than being re-derived
            // from a live read at build time, when the original may already have
            // been changed by somebody else.
            options: {
              unique: candidate.spec.unique,
              sparse: candidate.spec.sparse,
              collation: candidate.spec.collation,
              ...(candidate.spec.partialFilter === null
                ? {}
                : { partialFilter: candidate.spec.partialFilter }),
              ...(candidate.spec.include === undefined || candidate.spec.include.length === 0
                ? {}
                : { include: [...candidate.spec.include] }),
            },
          },
        });
        reordering.add(candidate.indexName);
      }

      // An index already covers the fields but in an order that cannot serve
      // the sort. No create is proposed for it — the fix is a second index
      // differing only in direction, which doubles this collection's write cost
      // and is a judgement call. Say so rather than drop it silently.
      //
      // Skipped where the re-order pass above has already proposed doing it
      // properly, which is the only case where there IS something better than
      // an advisory: rebuilding the one index rather than keeping two.
      for (const advisory of sortOrderAdvisories(shapes, existing, WORKLOAD_OPTIONS)) {
        if (reordering.has(advisory.existingIndex)) continue;
        const indexName = `${advisory.existingIndex}_sortorder`;
        if (cooled.has(cooldownKey(database, collection, indexName))) continue;
        const keys = advisory.wantedKeys.map((key) => `${key.field}: ${key.direction}`).join(", ");
        toInsert.push({
          clusterId,
          type: "ADVISORY_REVIEW",
          state: "PROPOSED",
          source: "WORKLOAD",
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

      // Highest-scoring first, so the crowding term below charges the BEST
      // candidate the smallest penalty (#281). Left in derivation order, the
      // staircase would fall on whichever shape the profiler happened to emit
      // first — a real decision made by an accident of iteration order.
      const creates = [...recommendCreates(shapes, existing, WORKLOAD_OPTIONS)].sort(
        (a, b) => b.count - a.count,
      );
      const budgetKey = `${database} ${collection}`;
      for (const candidate of creates) {
        // Partial variants get a suffix so they never collide with the full
        // index of the same keys.
        const indexName =
          proposedName(candidate.keys) + (candidate.partialFilter === undefined ? "" : "_partial");
        if (cooled.has(cooldownKey(database, collection, indexName))) continue;
        if (standing.has(watchKey(database, collection, indexName))) continue;
        // Net-new only. A candidate that retires what it replaces leaves the
        // collection carrying the same number of indexes or fewer, so it answers
        // to no budget — see collection-budget.ts.
        const netNew = candidate.retireIndexes.length === 0;
        const collectionIndexes = collectionIndexesAfterBuild(
          existing.length,
          pendingBuilds.get(budgetKey) ?? 0,
        );
        // The collection's writes are already slower than before the last run of
        // builds finished (#282). Same conclusion as a crowded collection and a
        // stronger reason for it: this one is measured rather than counted.
        const regressed = cooled.has(collectionCooldownKey(database, collection));
        const crowded = (netNew && crowdingPenalty(collectionIndexes) > 0) || regressed;
        const score = createScore({
          collscan: candidate.scanning,
          sortedInMemory: !candidate.scanning,
          count: candidate.count,
          docCount,
          severity,
          regressionWeight: regressionWeights.get(`${database} ${collection} ${indexName}`) ?? 0,
          ...(netNew ? { collectionIndexes } : {}),
        });
        // Severity is the collection's, not this candidate's, so a sort-driven
        // candidate must not inherit a different shape's scan as grounds for
        // building itself without being asked.
        //
        // `crowded` is a veto here rather than a penalty, because this path does
        // not read the score at all: instantCreate builds on the strength of the
        // scan alone, so the crowding term below would never reach it. A
        // collection already absorbing builds gets its next one PROPOSED — the
        // finding stays, the unattended build does not.
        //
        // Split from `crowded` so the COUNT below can be honest. `crowded && !instant`
        // counted every crowded candidate that was not built unattended — including
        // the ones nothing was going to build anyway, because the cluster is
        // read-only, or instantCreate is off, or the scan is ROUTINE. Measured on a
        // read-only cluster the moment it shipped: `{"budget": 24}`, on a cluster
        // where the budget had decided nothing at all and read-only had decided
        // everything. A feature whose whole purpose is saying what the engine held
        // back must not claim credit for what something else held back.
        const unattended = wouldBuildUnattended({
          type: candidate.type,
          scanning: candidate.scanning,
          severity,
          count: candidate.count,
          minCount: INSTANT_MIN_COUNT,
          instantCreateEnabled: automation.instantCreate,
          readOnly,
        });
        const instant = unattended && !crowded;
        if (instant) instantApproved += 1;
        if (unattended && crowded) heldFromInstant += 1;
        // Count it before the next candidate is scored: the second create for one
        // collection is charged for the first, which is the whole point.
        if (netNew) pendingBuilds.set(budgetKey, (pendingBuilds.get(budgetKey) ?? 0) + 1);
        // A CRITICAL scan is paid on every execution; waiting for the quiet
        // window can mean most of a day of it.
        const urgent = instant && severity === "CRITICAL";
        toInsert.push({
          clusterId,
          type: candidate.type,
          state: instant ? "APPROVED" : "PROPOSED",
          source: "WORKLOAD",
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
            cost +
            // Said in the row itself, not only in the score (#281). A number
            // that came out lower than a reader expects is the engine looking
            // arbitrary; the sentence is what makes it an argument they can
            // agree or disagree with.
            (regressed
              ? ` ${collection}'s writes are measurably slower than before the last run of builds ` +
                `on it, so this one is left for you to approve rather than built unattended.`
              : crowded
                ? ` This would be index ${collectionIndexes} on ${collection}, and every write to ` +
                  `the collection updates all of them — so its score is reduced and it is left ` +
                  `for you to approve rather than built unattended.`
                : ""),
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

      // The other direction: an index carrying keys nothing asks for. Same
      // machinery as MERGE — build the shorter index, and once it has survived
      // its post-build watch, finalize.ts proposes retiring the long one
      // through the ordinary hide → observe → regression gate.
      for (const candidate of recommendNarrowing(shapes, existing, WORKLOAD_OPTIONS)) {
        const indexName = proposedName(candidate.keys);
        if (cooled.has(cooldownKey(database, collection, indexName))) continue;
        if (standing.has(watchKey(database, collection, indexName))) continue;
        // An index on exactly these keys already exists, or another candidate
        // this pass already claimed the name.
        if (existing.some((idx) => idx.name === indexName)) continue;
        if (toInsert.some((row) => row.collection === collection && row.indexName === indexName)) {
          continue;
        }
        // What the trailing keys cost, prorated by key count. Crude — key size
        // varies by field and every entry also carries a record id — but it is
        // the difference between "reclaims 4 KB" and "reclaims 3 GB", which is
        // the distinction that decides whether the rebuild is worth it.
        const currentBytes = sizes[candidate.indexName] ?? 0;
        const totalKeys = candidate.keys.length + candidate.droppedKeys.length;
        const saving = Math.round((currentBytes * candidate.droppedKeys.length) / totalKeys);
        if (saving < NARROW_MIN_SAVING_BYTES) continue;
        toInsert.push({
          clusterId,
          type: "UPDATE",
          state: "PROPOSED",
          source: "WORKLOAD",
          database,
          collection,
          indexName,
          rationale: `${candidate.rationale}${cost}`,
          score: narrowScore({
            observedCount: candidate.observedCount,
            droppedKeys: candidate.droppedKeys.length,
            totalKeys,
            sizeBytes: currentBytes,
            regressionWeight: regressionWeights.get(`${database} ${collection} ${indexName}`) ?? 0,
          }),
          // Claimed at retirement, not now: the long index is still there and
          // still costing until it is actually dropped.
          estimatedBytesSaved: 0,
          targetSpec: { keys: encodeKeys(candidate.keys), retire: [candidate.indexName] },
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
      // Same cost gate as other creates, in the same units. An unindexed join
      // walks the foreign collection at least once per execution — more, since
      // it repeats per input document — so size times join rate is the floor of
      // what it costs, and a floor is enough to decide by.
      const { docCount: foreignDocs } = await collector.collectionStorage(want.database, want.from);
      if (foreignDocs < TRIVIAL_COLLECTION_DOCS) continue;
      if (foreignDocs * want.perWeek < MIN_WEEKLY_DOCS_EXAMINED) continue;
      const indexName = `${want.foreignField}_1`;
      if (cooled.has(cooldownKey(want.database, want.from, indexName))) continue;
      if (standing.has(watchKey(want.database, want.from, indexName))) continue;
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
        source: "WORKLOAD",
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
          regressionWeight:
            regressionWeights.get(`${want.database} ${want.from} ${indexName}`) ?? 0,
        }),
        estimatedBytesSaved: 0,
        targetSpec: { keys: [want.foreignField], retire: [] },
      });
    }
    // This job's own findings, identified by who wrote them rather than by
    // guessing from the type and a name suffix.
    await db
      .delete(recommendations)
      .where(
        and(
          eq(recommendations.clusterId, clusterId),
          eq(recommendations.state, "PROPOSED"),
          eq(recommendations.source, "WORKLOAD"),
        ),
      );
    // See classify.ts: the same losing-race-is-a-no-op reading of
    // recommendations_one_live_claim (#283).
    if (toInsert.length > 0)
      await db.insert(recommendations).values(toInsert).onConflictDoNothing();
    created = toInsert.length;
    // This pass's own account of what it declined to do by itself (#277/#281).
    // Its own row rather than classify's, which is why analysis_notes is keyed by
    // producer: the usage gate refusing has nothing to do with a crowded
    // collection, and one pass must not overwrite the other's explanation.
    //
    // No usage columns — this producer has no usage gate, so leaving them zero is
    // the honest answer rather than a claim that nothing was trusted.
    await db
      .insert(analysisNotes)
      .values({
        clusterId,
        source: "WORKLOAD",
        decidedAt: new Date(),
        suppressed: heldFromInstant > 0 ? { budget: heldFromInstant } : {},
      })
      .onConflictDoUpdate({
        target: [analysisNotes.clusterId, analysisNotes.source],
        set: {
          decidedAt: new Date(),
          suppressed: heldFromInstant > 0 ? { budget: heldFromInstant } : {},
        },
      });
  } finally {
    release();
  }
  // Build the auto-approved creates now rather than waiting for the scheduler.
  // Anything not marked urgent still waits for the change window inside.
  if (instantApproved > 0) await applyCreatesForCluster(db, clusterId);
  return created;
}
