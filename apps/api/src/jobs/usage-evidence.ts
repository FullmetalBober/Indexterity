import type { UsageFold } from "../analysis";
import { type Database, sql } from "../db";

// Everything `classify` asks of `index_snapshots`, folded in postgres (#534).
//
// It used to read the cluster's whole retained window of raw runs and walk them
// in JS. #485 looked at doing this and declined, on a premise that has since been
// measured false: that `index_snapshots` run-length-collapses well enough (76%
// then) for its rows to be proportional to how much the cluster CHANGES rather
// than to how long we have watched. On the busiest production cluster it folds at
// **1.26x** — 29,892 rows for 37,714 observations — because an index's
// `size_bytes` genuinely moves on a busy cluster, and the table grows at 2,493
// rows a day. At the 183-day PRO entitlement that read is 116.9 MB per pass,
// hourly, per cluster.
//
// The OTHER reason #485 declined was that the gap checks and `counterEpochs`
// compare adjacent runs member by member, on `ops` and `since`. That is no longer
// true either: #537 moved those facts onto the row at write time, where the
// collector already held both sides. Every input to the two gates is now a sum, a
// count, a max, or a pass over consecutive pairs — so `lag()` and `sum() over`
// express them exactly and the answer is O(indexes) rather than O(indexes ×
// collects).
//
// NOTHING IS TRUNCATED, and that is the whole point of folding rather than
// trimming. The tempting reading of "bound the engine's read" is *read fewer
// days*, which is refused here for the reason D96 measured and D148 recorded: a
// truncated history cannot see a cadence, so a monthly job's index reads
// FLAT_ZERO — score 50, droppable, the most confident verdict the engine has —
// where the full series reads PERIODIC_ALIVE, which is not droppable at all.
// Wrong answer, MORE confident, on LESS evidence, and nothing about the finding
// looks unusual. A fold over the full window has no such property: the
// entitlement still bounds what may be concluded, and what crosses the wire is
// bounded by the index count instead.
//
// The RULES stay in `analysis/`. This computes arithmetic; `usageTrustRefusalFrom`
// and `classifyUsageFrom` decide what it means. A query that reproduced the
// thresholds would be a second copy of them, free to drift with nothing in the
// data to notice; a query that reproduces the arithmetic can be cross-checked
// against `foldUsage` over the same rows, which is what
// `usage-evidence.int.test.ts` does.

/** The fold for one index, plus the handful of facts about it that are not history. */
export interface IndexEvidence {
  readonly usage: UsageFold;
  /** The newest run's size, which is the live number every caller wants. */
  readonly sizeBytes: number;
  /** How many members the newest reading spoke for — the roster-less fallback (#528). */
  readonly memberCount: number;
  /**
   * Seen as the target of a hint() ANYWHERE in the retained history.
   *
   * `bool_or` and not the newest run's flag: one sighting protects the index, and
   * a quiet collect must not erase it. The same stickiness the writer applies
   * when it extends a run.
   */
  readonly hinted: boolean;
}

/** One entry per index, keyed by `index_id`. */
export type UsageEvidence = ReadonlyMap<string, IndexEvidence>;

// snake_case, because these are the column names postgres returns and drizzle's
// `execute` does not map them — `db.execute` is the raw path, so this shape is a
// claim about the query below rather than something the compiler checks. Every
// field is read defensively in `foldFrom` for the same reason.
interface EvidenceRow extends Record<string, unknown> {
  readonly index_id: string;
  readonly runs: number | string;
  readonly observations: number | string | null;
  readonly active_runs: number | string | null;
  readonly trusted_watch_ms: number | string | null;
  readonly newest_end_ms: number | string | null;
  readonly latest_activity_ms: number | string | null;
  readonly max_interior_gap_ms: number | string | null;
  readonly max_between_gap_ms: number | string | null;
  readonly size_bytes: number | string | null;
  readonly member_count: number | string | null;
  readonly hinted: boolean | null;
}

function evidenceQuery(clusterId: string, since: Date) {
  return sql`
    -- Every run in the window with its neighbour alongside it, sorted once.
    --
    -- previous_members and ordinal are here for the fallback below and cost
    -- nothing when it is not taken.
    with ordered as (
      select
        index_id,
        captured_at,
        -- spanEnd: a lastSeenAt behind the start would be a run of negative
        -- length, and analysis/types.ts reads it as the point reading it must
        -- have been. Stated the same way here.
        greatest(last_seen_at, captured_at) as span_end,
        observations,
        max_gap_ms,
        size_bytes,
        hinted,
        jsonb_array_length(per_member) as member_count,
        ops_delta,
        ops_total,
        counters_restarted,
        counters_started_at,
        per_member,
        row_number() over w as ordinal,
        lag(per_member) over w as previous_members,
        lag(greatest(last_seen_at, captured_at)) over w as previous_end
      from index_snapshots
      where cluster_id = ${clusterId} and last_seen_at >= ${since}
      window w as (partition by index_id order by captured_at)
    ),
    -- One row per run, normalised to what the analysis asks of it.
    --
    -- The stored columns answer on every row the collector priced, which after
    -- #537's backfill is all of them. The per_member arms are the rolling-deploy
    -- fallback: an api predating those columns can still insert a row without
    -- them, and deriving nothing there would read the run as idle — the direction
    -- that costs a drop somebody regrets.
    --
    -- The FIRST run in the window takes the total, not the delta. Its predecessor
    -- is outside the window, so the engine reads it in full — "the latest instant
    -- it could have happened, the conservative end, and the only one the data
    -- supports" — and a delta here would quietly narrow that.
    priced as (
      select
        index_id,
        captured_at,
        span_end,
        observations,
        max_gap_ms,
        size_bytes,
        hinted,
        member_count,
        ordinal,
        previous_end,
        case
          when ordinal = 1 then coalesce(ops_total, (
            select coalesce(sum(greatest(0, (e ->> 'ops')::bigint)), 0)
            from jsonb_array_elements(per_member) e
          ))
          else coalesce(ops_delta, (
            select coalesce(sum(
              case
                when prev.ops is null
                  or prev.since is distinct from cur.since
                  or cur.ops < prev.ops
                then greatest(0, cur.ops)
                else cur.ops - prev.ops
              end), 0)
            from (
              select e ->> 'member' as member, e ->> 'since' as since, (e ->> 'ops')::bigint as ops
              from jsonb_array_elements(per_member) e
            ) cur
            left join (
              select e ->> 'member' as member, e ->> 'since' as since, (e ->> 'ops')::bigint as ops
              from jsonb_array_elements(coalesce(previous_members, '[]'::jsonb)) e
            ) prev on prev.member = cur.member
          ))
        end as ops,
        coalesce(counters_restarted, (
          select coalesce(bool_or(
            cur.ops < prev.ops
            or (prev.since is not null and cur.since is not null and cur.since > prev.since)), false)
          from (
            select e ->> 'member' as member, e ->> 'since' as since, (e ->> 'ops')::bigint as ops
            from jsonb_array_elements(per_member) e
          ) cur
          join (
            select e ->> 'member' as member, e ->> 'since' as since, (e ->> 'ops')::bigint as ops
            from jsonb_array_elements(coalesce(previous_members, '[]'::jsonb)) e
          ) prev on prev.member = cur.member
        )) as restarted,
        coalesce(counters_started_at, (
          select max((e ->> 'since')::timestamptz)
          from jsonb_array_elements(per_member) e
          where e ->> 'since' is not null
        )) as counters_started_at
      from ordered
    ),
    -- A restart ENDS an epoch and begins the next, so a running count of them
    -- names the epoch each run belongs to.
    --
    -- The window's first run is deliberately not a boundary: counterEpochs
    -- never asks whether it restarted, because a boundary is only visible
    -- BETWEEN two snapshots. A cumulative sum reproduces that without a special
    -- case — incrementing on the very first row shifts every id by one and
    -- splits nothing.
    epoched as (
      select
        *,
        sum(case when restarted then 1 else 0 end)
          over (partition by index_id order by captured_at) as epoch
      from priced
    ),
    epochs as (
      select
        index_id,
        epoch,
        min(captured_at) as epoch_start,
        max(span_end) as epoch_end,
        -- The epoch's FIRST run's counter start, not the newest in it: an epoch
        -- cannot testify to anything before its own counters began, and that is
        -- a fact about where it starts.
        (array_agg(counters_started_at order by captured_at))[1] as first_started
      from epoched
      group by index_id, epoch
    ),
    -- An epoch begins where we started reading it OR where its counters started,
    -- whichever is LATER, and cannot run past its own end. The clamp is the whole
    -- of the old counters-younger-than-span rule: a cluster whose first collect
    -- landed after a restart looks unbroken, and dating it from that collect would
    -- credit us with watching a counter that did not exist yet.
    watched as (
      select
        index_id,
        sum(
          extract(epoch from (
            epoch_end - least(greatest(epoch_start, coalesce(first_started, epoch_start)), epoch_end)
          )) * 1000
        )::double precision as trusted_watch_ms
      from epochs
      group by index_id
    )
    select
      p.index_id,
      count(*)::int as runs,
      sum(p.observations)::bigint as observations,
      -- usageSeries credits a run that moved exactly ONE active look and reads
      -- its tail as idle time, so this counts runs and not their observations.
      count(*) filter (where p.ops > 0)::bigint as active_runs,
      w.trusted_watch_ms,
      (extract(epoch from max(p.span_end)) * 1000)::double precision as newest_end_ms,
      -- A burst is dated to the instant the counter jumped, which is the run's
      -- own START and not the end of the silence that followed it.
      (extract(epoch from max(p.captured_at) filter (where p.ops > 0)) * 1000)::double precision
        as latest_activity_ms,
      coalesce(max(p.max_gap_ms), 0)::double precision as max_interior_gap_ms,
      coalesce(max(extract(epoch from (p.captured_at - p.previous_end)) * 1000), 0)::double precision
        as max_between_gap_ms,
      -- The newest run's size and member count, which are facts about the index
      -- now rather than about its history.
      (array_agg(p.size_bytes order by p.captured_at desc))[1]::bigint as size_bytes,
      (array_agg(p.member_count order by p.captured_at desc))[1]::int as member_count,
      -- Sticky across the whole window, not the newest run's flag: one sighting
      -- anywhere protects the index and a quiet collect must not erase it.
      bool_or(p.hinted) as hinted
    from priced p
    join watched w on w.index_id = p.index_id
    group by p.index_id, w.trusted_watch_ms
  `;
}

// Defensive, for the reason `EvidenceRow` gives: this is the raw path, so a
// number is what postgres says it is rather than what the type claims. `bigint`
// arrives as a string from node-postgres.
function count(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

export async function usageEvidence(
  db: Database,
  clusterId: string,
  since: Date,
): Promise<UsageEvidence> {
  const result = await db.execute<EvidenceRow>(evidenceQuery(clusterId, since));
  const folds = new Map<string, IndexEvidence>();
  for (const row of result.rows) {
    if (typeof row.index_id !== "string") continue;
    // `latestActivityMs` is NULL when nothing in the window moved, which is a
    // different statement from "moved at time zero" — `classifyUsageFrom` reads
    // the null as FLAT_ZERO rather than as an ancient burst.
    const latest = row.latest_activity_ms;
    folds.set(row.index_id, {
      usage: {
        runs: count(row.runs),
        observations: count(row.observations),
        activeRuns: count(row.active_runs),
        trustedWatchMs: count(row.trusted_watch_ms),
        newestEndMs: count(row.newest_end_ms),
        latestActivityMs: latest === null || latest === undefined ? null : count(latest),
        maxInteriorGapMs: count(row.max_interior_gap_ms),
        maxBetweenGapMs: count(row.max_between_gap_ms),
      },
      sizeBytes: count(row.size_bytes),
      memberCount: count(row.member_count),
      hinted: row.hinted === true,
    });
  }
  return folds;
}
