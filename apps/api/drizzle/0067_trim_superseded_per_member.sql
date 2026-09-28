-- Empty `per_member` on every run a newer one has superseded (#550).
--
-- `per_member` is a run's identity and its raw cumulative counters. The newest
-- run per index still needs it: the next collect fingerprints it and
-- differences against it, and the live readers read the last collect's batch.
-- A superseded run is read only as history, and history reads the stored
-- columns #537 added, touching `per_member` only where they are missing. On a
-- three-member replica set the JSON is 402 of the 841 bytes each row costs on
-- disk.
--
-- The collector does this from now on (jobs/collect.ts, trimSupersededMembers),
-- and this is the same rule applied once to the history already stored. It
-- trims a run only when every fallback that could read its JSON is closed:
--
--   * its own stored columns are present, so nothing differences it;
--   * its SUCCESSOR's are present too, since a successor without them
--     differences against this run's counters (`lag(per_member)` in
--     jobs/usage-evidence.ts).
--
-- `counters_started_at` needs no guard of its own. Its fallback is the latest
-- `since` in the JSON, and the column was only ever written from that same JSON
-- (the collector since #537, migration 0066 before it), so a null already means
-- the JSON had no `since` to give.
--
-- Rows an api predating #537 wrote during a rolling deploy fail the first two
-- and keep their JSON, which is exactly the case the fallback exists for.
-- `usage-evidence.int.test.ts` runs this file and asserts that the fold is
-- unchanged by it, field by field.
with ordered as (
  select
    id,
    lead(id) over w as successor,
    lead(ops_delta) over w as successor_delta,
    lead(counters_restarted) over w as successor_restarted
  from index_snapshots
  window w as (partition by index_id order by captured_at)
)
update index_snapshots s
set per_member = '[]'::jsonb
from ordered o
where s.id = o.id
  and o.successor is not null
  and o.successor_delta is not null
  and o.successor_restarted is not null
  and s.per_member <> '[]'::jsonb
  and s.ops_delta is not null
  and s.ops_total is not null
  and s.counters_restarted is not null;
