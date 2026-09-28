// Work on the queue that the schedule cannot see, as one in-memory fact the tick
// reads.
//
// Once FAST_PASS_INTERVAL_MINUTES is raised, the external tick answers from
// memory when nothing became due since its last complete drain (tick.service.ts)
// — that is what lets a database that suspends on idle actually sleep between
// the occurrences that matter. Two kinds of job reach the queue without the
// schedule knowing: one a request handler put straight onto it — the
// dashboard's "collect now", and the first collect after a cluster is connected
// — and a failed attempt graphile-worker put back for a retry. Without this,
// either would sit until the next fast-pass occurrence, up to
// FAST_PASS_INTERVAL_MINUTES, when it used to wait for the next ping.
//
// A flag, not a count, because the drain that follows takes whatever is queued
// however many things put it there. Per process, which is the limit worth
// knowing: on a multi-replica install a collect queued on one replica and a ping
// landing on another still waits for the next occurrence. That is bounded by the
// fast interval, and a single replica — the case this exists for — never sees it.
//
// Not a provider: there is nothing to substitute and nothing it depends on, and
// wrapping it in @Injectable would only cost the callers inference.
let queued = false;

export function noteQueuedWork(): void {
  queued = true;
}

export function queuedWorkPending(): boolean {
  return queued;
}

// Called as a drain STARTS, not when it ends: whatever was queued before the
// drain began is the drain's to take, and anything queued while it runs is still
// picked up, because runOnce drains to depth. A retry put back DURING the drain
// raises the flag again after the clear, and that is right too — its backoff
// means this drain leaves it for the next one.
export function clearQueuedWork(): void {
  queued = false;
}
