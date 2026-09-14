-- Store what each run's counters MEAN, not only what they were (#534).
--
-- `per_member` is the run's identity and its raw cumulative counters. The
-- analysis never wants those: it wants the ACTIVITY across the run, which is a
-- difference against the run before it. Computing that on read is what made
-- every reader load `per_member` for the whole retained window — 60.5% of the
-- bytes classify reads on the five-node production cluster — and made the fold
-- depend on each row's neighbour, which is what stops it being an aggregate.
--
-- Nullable, and backfilled below. A reader that finds null differences
-- `per_member` the way it always did.
alter table "index_snapshots" add column "ops_delta" bigint;
alter table "index_snapshots" add column "ops_total" bigint;
alter table "index_snapshots" add column "counters_restarted" boolean;
alter table "index_snapshots" add column "counters_started_at" timestamp with time zone;

-- The backfill is analysis/usage.ts `activityBetween`, in SQL, once.
--
-- A member counts IN FULL when it has no predecessor, when its `since` moved
-- (the counter restarted under us), or when it went backwards (it restarted on
-- an engine whose reset carries no `since` to notice it by). Otherwise it counts
-- as the difference. `is distinct from` matches the JS `!==` on two absent
-- `since` keys, where a plain `<>` would yield null and lose the row.
--
-- Both sides are expanded into named columns before the join rather than being
-- compared as jsonb in place. `select e from jsonb_array_elements(x) as e` binds
-- `e` as the TABLE alias and yields the composite row, not the element, so the
-- comparisons silently read as equal and every delta came out zero — checked
-- against 55,247 production rows, where that shape disagreed with the engine on
-- 47,952 of them and this one disagrees on none.
with ordered as (
  select
    id,
    per_member,
    lag(per_member) over (partition by index_id order by captured_at) as previous
  from index_snapshots
),
computed as (
  select
    o.id,
    coalesce((
      select sum(
        case
          when prev.ops is null
            or prev.since is distinct from cur.since
            or cur.ops < prev.ops
          then greatest(0, cur.ops)
          else cur.ops - prev.ops
        end)
      from (
        select e ->> 'member' as member, e ->> 'since' as since, (e ->> 'ops')::bigint as ops
        from jsonb_array_elements(o.per_member) e
      ) cur
      left join (
        select e ->> 'member' as member, e ->> 'since' as since, (e ->> 'ops')::bigint as ops
        from jsonb_array_elements(coalesce(o.previous, '[]'::jsonb)) e
      ) prev on prev.member = cur.member
    ), 0) as ops_delta,
    coalesce((
      select sum(greatest(0, (e ->> 'ops')::bigint))
      from jsonb_array_elements(o.per_member) e
    ), 0) as ops_total,
    -- restartedBetween: a member whose counter went BACKWARDS, or whose `since`
    -- moved FORWARD. A member the previous run did not have is skipped rather
    -- than treated as a restart, which is what the engine does.
    coalesce((
      select bool_or(
        cur.ops < prev.ops
        or (prev.since is not null and cur.since is not null and cur.since > prev.since))
      from (
        select e ->> 'member' as member, e ->> 'since' as since, (e ->> 'ops')::bigint as ops
        from jsonb_array_elements(o.per_member) e
      ) cur
      join (
        select e ->> 'member' as member, e ->> 'since' as since, (e ->> 'ops')::bigint as ops
        from jsonb_array_elements(coalesce(o.previous, '[]'::jsonb)) e
      ) prev on prev.member = cur.member
    ), false) as counters_restarted,
    -- countersStartedAt: the LATEST `since` any of this run's members claims.
    (
      select max((e ->> 'since')::timestamptz)
      from jsonb_array_elements(o.per_member) e
      where e ->> 'since' is not null
    ) as counters_started_at
  from ordered o
)
update index_snapshots s
set ops_delta = computed.ops_delta,
    ops_total = computed.ops_total,
    counters_restarted = computed.counters_restarted,
    counters_started_at = computed.counters_started_at
from computed
where computed.id = s.id;
