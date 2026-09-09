import type { ActivityFold, ObservationFold } from "../analysis";
import { type Database, sql } from "../db";
import { workloadKey } from "../engine/ports";

// The two things `classify` asks of `latency_samples`, folded in postgres (#484,
// #485).
//
// It used to read the cluster's whole retained window of raw rows and reduce them
// in JS. `latency_samples` is the one table that run-length-collapses NOTHING —
// measured at 76% for `index_snapshots` and 0% here, because `$collStats` totals
// move on any operation, so a live collection differs at every look — so that read
// is one row per collection per collect for the length of the entitlement. On PRO
// that is 183 days, re-read on every pass, and it is the term that grows strictly
// linearly with time forever.
//
// What the analysis actually needs from it is two scalars per collection:
//
//   The ACTIVITY fold. Hours in which the collection served reads, which is what
//   licenses "this index served none of them" (analysis/activity.ts). Consecutive
//   `read_ops` differenced, each interval credited at most the median observation
//   gap.
//
//   The OBSERVATION fold. Whether an observe window on this collection could
//   finish inside the wall clock the cap allows (analysis/observed.ts). Elapsed
//   span against summed drawable window length.
//
// Both are folds over consecutive pairs, so `lag()` expresses them exactly and the
// answer is O(collections) rather than O(collections × collects).
//
// NOTHING IS TRUNCATED, and that is the point of doing it this way. #485 asked for
// an engine read bounded by something other than the plan entitlement, and the
// tempting reading is "read fewer days" — which is refused here for a reason the
// repo has already measured (D96, and D148 records it again): a truncated history
// cannot see a cadence, so a monthly job's index reads `FLAT_ZERO` (score 50,
// droppable, our most confident verdict) instead of `PERIODIC_ALIVE`. That is a
// wrong verdict, arrived at with MORE confidence on LESS evidence, and it has no
// symptom. A fold over the full window has no such property: the entitlement still
// bounds what may be concluded, and what crosses the wire is bounded by the
// collection count instead.
//
// The RULES stay in `analysis/`. This computes sums; `activeHoursFrom` and
// `observationCanFinishFrom` decide what they mean. That is deliberate — a query
// that reproduced the thresholds would be a second copy of them, free to drift
// with nothing in the data to notice. A query that reproduces the arithmetic can
// be cross-checked against the JS over the same rows, which is what
// `latency-evidence.int.test.ts` does.
//
// MEASURED, on postgres 18 against the hosted deployment's shape extrapolated to a
// full PRO entitlement: 144 namespaces at an hourly cadence for 183 days, 632,448
// rows, a 195 MB table. `explain (analyze, serialize text)`:
//
//   |                  | server time | serialized output |
//   |------------------|-------------|-------------------|
//   | ten raw columns  | 899 ms      | 75,665 kB         |
//   | this fold        | 3,981 ms    | 11 kB             |
//
// So the trade is named rather than glossed: server time goes UP roughly four
// times, and what crosses the wire goes down by a factor of about 6,900. That is
// the right way round for the problem — the deployment ran out of network
// transfer, not CPU — and the pass has a five-minute budget it now uses 1.3% of.
// 601 ms of the old query's 899 was postgres serialising the answer, which is the
// clearest statement of what was being paid for.
//
// The remaining cost is the sort behind the window, not the median: the gaps are
// grouped to one row per DISTINCT interval before the median is taken, so on a
// steady cadence that stage sees a handful of rows per namespace.
//
// WHAT IS NOT CUT, and why (#485's enumeration). Each gate over `index_snapshots`
// asked what its minimum evidence is, since a gate quietly reading less than it
// thinks it does is a wrong verdict with no symptom:
//
//   `usageTrustRefusal`'s observation and span floors — summarisable in principle:
//   they count observations and sum epoch spans. Not worth summarising, because
//   `index_snapshots` run-length-collapses (76% measured) and its rows are
//   therefore proportional to how much the cluster CHANGES, not to how long we
//   have watched.
//
//   `usageTrustRefusal`'s two gap checks and `counterEpochs`/`restartedBetween` —
//   NOT summarisable. They compare ADJACENT runs, member by member, on `ops` and
//   `since`. A summary that carried anything less would silently stop detecting a
//   counter restart, and a restart undetected is a differenced series read across
//   a reset.
//
//   `classifyUsage` — NOT truncatable, which is the one that decides this. A
//   truncated history cannot see a cadence, so a monthly job's index reads
//   FLAT_ZERO (score 50, droppable, the most confident verdict the engine has)
//   where the full series reads PERIODIC_ALIVE (not droppable at all). Wrong
//   answer, MORE confident, on LESS evidence, and nothing about the resulting
//   finding looks unusual. That is D96's objection and the reason this file folds
//   over the whole window instead of reading part of it.

/** Both folds for one collection, keyed by `workloadKey`. */
export interface CollectionEvidence {
  readonly activity: ActivityFold;
  readonly observation: ObservationFold;
}

// snake_case, because these are the column names postgres returns and drizzle's
// `execute` does not map them — `db.execute` is the raw path, so the shape here is
// a claim about the query above rather than something the compiler checks against
// the schema. Every numeric field is read defensively below for the same reason.
interface EvidenceRow extends Record<string, unknown> {
  readonly database: string;
  readonly collection: string;
  // Null when the collection has no gap between two readings — one row, or every
  // reading stamped at the same instant. `foldActivity` reports that as
  // `measurable: false` rather than as zero active time, and so does this.
  readonly cap_ms: number | null;
  readonly active_ms: number | null;
  readonly elapsed_ms: number;
  readonly drawable_ms: number | null;
}

// The read metric, and only it. `classify` asks the read question; `finalize` asks
// the write one over the raw readings it already has for its own window, so there
// is no second branch to carry here.
//
// Every quantity is `double precision`, not `numeric`. That is not tidiness: the
// JS side computes in IEEE-754 doubles, and postgres' `numeric` division rounds
// decimally — so a numeric fold would differ from the JS fold in the last places
// and the cross-check that holds the two together would have to be approximate.
// Casting makes it exact.
function evidenceQuery(clusterId: string, since: Date) {
  return sql`
    -- One pass over the window, sorted once, with every reading's neighbour
    -- alongside it.
    with readings as (
      select
        database,
        collection,
        read_ops,
        read_latency_micros,
        captured_at,
        last_seen_at,
        observations,
        -- sortedRuns orders by captured_at, and captured_at alone is already a
        -- TOTAL order within a partition: the exclusion constraint
        -- latency_samples_no_overlap forbids two runs for one namespace whose
        -- spans intersect, so no two can share a start. A tie-break here would be
        -- unreachable and not free — it would widen the sort key past anything an
        -- index could serve.
        lag(last_seen_at) over w as prev_end,
        lag(read_ops) over w as prev_read_ops,
        lag(read_latency_micros) over w as prev_read_micros
      from latency_samples
      where cluster_id = ${clusterId}::uuid
        and last_seen_at >= ${since.toISOString()}::timestamptz
      window w as (partition by database, collection order by captured_at)
    ),
    -- Everything either fold needs from one reading and the one before it,
    -- derived once. Two consumers below, so postgres materialises this and reads
    -- it twice rather than re-deriving it — which is the whole reason the shape is
    -- one wide CTE instead of the four narrow ones this started as. Four
    -- consumers meant four passes over the cluster's whole window; two means two.
    steps as (
      select
        database,
        collection,
        captured_at,
        last_seen_at,
        -- The interval between two consecutive readings: from the moment a state
        -- was last confirmed to the moment the next was first seen. Null on the
        -- first reading of a namespace, which has nothing before it.
        case
          when prev_end is not null
          then extract(epoch from (captured_at - prev_end))::double precision * 1000
        end as between_ms,
        -- A run of n observations spanning s ms stands for n-1 evenly spaced
        -- intervals — run-length storage discarded the individual stamps, so this
        -- is what analysis/types.ts observationGaps reconstructs.
        case
          when observations > 1 and last_seen_at > captured_at
          then extract(epoch from (last_seen_at - captured_at))::double precision
               * 1000 / (observations - 1)::double precision
        end as interior_ms,
        (observations - 1)::bigint as interior_weight,
        -- Did the read counter MOVE across this interval? That is where the
        -- collection's traffic is.
        prev_end is not null and read_ops - prev_read_ops > 0 as moved,
        -- Was this a window a µs/op reading could be drawn from? Only a counter
        -- that went BACKWARDS disqualifies one. A window with no operations in it
        -- is still time we watched, and during which nothing could have been
        -- hurt — filtering those out is what made a quiet collection accumulate
        -- no observation at all and its observe window never fill.
        prev_end is not null
          and read_ops - prev_read_ops >= 0
          and read_latency_micros - prev_read_micros >= 0 as drawable
      from readings
    ),
    -- Every interval between two consecutive OBSERVATIONS, with what it weighs,
    -- and identical lengths collapsed to one row apiece.
    --
    -- That collapse is where this stops costing what the raw read cost: a steady
    -- hourly cadence produces thousands of gaps per namespace and a handful of
    -- DISTINCT lengths among them, so the sort that finds the median goes from one
    -- row per collect to one row per distinct interval.
    --
    -- Exactly equivalent to walking the individual gaps, which is worth showing
    -- rather than asserting. The grouped cumulative at a length v equals the JS
    -- cumulative after the LAST gap of that length, so the first v whose
    -- cumulative clears half is the same v the JS walk stops on. The
    -- mean-of-two-middle branch survives it too: if the JS lands exactly on half
    -- MID-group its next gap has the same length, so its mean is v — and the
    -- grouped cumulative there is strictly past half, which takes the plain branch
    -- and also answers v. It lands on half at a group BOUNDARY exactly when the
    -- grouped cumulative does, and then both take the mean with the next distinct
    -- length. latency-evidence.int.test.ts checks it against the JS on fixtures
    -- shaped for each of those cases.
    --
    -- A union of two filtered scans rather than a lateral over a two-row VALUES
    -- list. The lateral reads better and plans as a nested loop with one Values
    -- Scan per reading -- 632,448 loops on the fixture below. Measured end to end
    -- the union is only ~8% ahead (3.7s against 4.0s), because both are dominated
    -- by the sort and window over the whole retained window; it is chosen on that
    -- margin and on not planning a per-row loop, not on a large difference.
    buckets as (
      select database, collection, ms, sum(weight) as weight
      from (
        select database, collection, interior_ms as ms, interior_weight as weight
        from steps
        where interior_ms is not null and interior_ms > 0
        union all
        select database, collection, between_ms as ms, 1::bigint as weight
        from steps
        where between_ms is not null and between_ms > 0
      ) as gap
      group by database, collection, ms
    ),
    -- The weighted median of those intervals, which is the per-interval cap on
    -- credited activity. Weighted because collapsing a hundred quiet collects
    -- into one row must not let the handful of intervals around them outvote the
    -- cadence (analysis/types.ts, medianObservationGap).
    ranked as (
      select
        database,
        collection,
        ms,
        sum(weight) over (
          partition by database, collection
          order by ms
          rows between unbounded preceding and current row
        ) as cumulative,
        sum(weight) over (partition by database, collection) as total,
        lead(ms) over (partition by database, collection order by ms) as next_ms
      from buckets
    ),
    -- The first interval at or past the halfway mark. Landing EXACTLY on it is
    -- the even-count case, where the median is the mean of the two middle values
    -- — the same rule the JS applies, and the reason next_ms is carried.
    median as (
      select distinct on (database, collection)
        database,
        collection,
        case
          when cumulative * 2 = total and next_ms is not null then (ms + next_ms) / 2
          else ms
        end as cap_ms
      from ranked
      where cumulative * 2 >= total
      order by database, collection, cumulative
    )
    -- Both folds, in one grouped pass over steps.
    --
    -- Activity sits in the intervals BETWEEN runs and never inside one: a run is a
    -- stretch over which the counter did NOT move, so it contributes no active
    -- time however long it is and however many collects confirmed it. Crediting a
    -- run's own length is the serious error available here — a collection idle for
    -- a month would report a month of traffic, and idleness would start funding
    -- the drops it exists to withhold.
    --
    -- The cap is what stops one outage manufacturing evidence: what a long
    -- interval tells you is that the collection was used SOMEWHERE in it, not
    -- throughout. cap_ms is not null is checked rather than left to least,
    -- which in postgres IGNORES a null argument and would silently credit the
    -- interval uncapped.
    select
      steps.database,
      steps.collection,
      max(median.cap_ms) as cap_ms,
      sum(
        case
          when steps.moved and median.cap_ms is not null
          then least(steps.between_ms, median.cap_ms)
        end
      ) as active_ms,
      extract(epoch from (max(steps.last_seen_at) - min(steps.captured_at)))::double precision
        * 1000 as elapsed_ms,
      sum(case when steps.drawable then steps.between_ms end) as drawable_ms
    from steps
    left join median
      on median.database = steps.database and median.collection = steps.collection
    group by steps.database, steps.collection
  `;
}

// Per-collection evidence for the cluster's whole entitled window.
//
// `since` is the plan window (jobs/plan.ts) and is passed through unchanged: what
// the engine may CONCLUDE from is still the entitlement. Only the number of rows
// that cross the wire to reach that conclusion has changed.
export async function collectionEvidence(
  db: Database,
  clusterId: string,
  since: Date,
): Promise<Map<string, CollectionEvidence>> {
  const result = await db.execute<EvidenceRow>(evidenceQuery(clusterId, since));
  const evidence = new Map<string, CollectionEvidence>();
  for (const row of result.rows) {
    evidence.set(workloadKey(row.database, row.collection), {
      // A collection with no interval between two readings has no median cap, and
      // the honest answer is "not measurable" rather than "no activity" — the same
      // distinction `foldActivity` makes when `medianObservationGap` returns zero.
      activity:
        row.cap_ms === null
          ? { activeMs: 0, measurable: false }
          : { activeMs: row.active_ms ?? 0, measurable: true },
      observation: {
        // A row exists because the collection has at least one reading in the
        // window; the aggregate only emits a group for a namespace that had one.
        hasHistory: true,
        elapsedMs: row.elapsed_ms,
        drawableMs: row.drawable_ms ?? 0,
      },
    });
  }
  return evidence;
}

// A collection the window holds no reading for at all. Distinct from one with
// readings that measure nothing: `observationCanFinishFrom` treats absent history
// as "not this gate's question", and treats a present history with no drawable
// window as a refusal.
export const NO_EVIDENCE: CollectionEvidence = {
  activity: { activeMs: 0, measurable: false },
  observation: { hasHistory: false, elapsedMs: 0, drawableMs: 0 },
};
