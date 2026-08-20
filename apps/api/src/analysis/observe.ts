import { observationGaps, sortedRuns, spanEnd, spanStart, totalObservations } from "./types";
import type { UsagePoint } from "./usage";

export interface ObserveWindow {
  readonly days: number;
  // Human-readable justification when the window differs from policy; null
  // when the policy baseline applies unchanged.
  readonly reason: string | null;
}

const DAY_MS = 86_400_000;
// Never shorten below a week (or the policy itself, when it's already tighter).
const SHORTEN_FLOOR_DAYS = 7;
// Periodic extension ceiling — a quarterly job is the longest cadence worth
// waiting out automatically.
const EXTEND_CAP_DAYS = 90;
// An index must appear at least this long after we started watching the cluster
// before its age means anything. Snapshots begin at onboarding, so on day one
// every index looks newborn — including the five-year-old ones.
const TENURE_MARGIN_DAYS = 1;
// Tenure past this multiple of the policy window makes an index a fixture of
// the schema rather than a recent addition.
const LONG_TENURE_MULTIPLE = 2;
// How much longer a long-lived, once-busy index is watched before its drop.
const VETERAN_MULTIPLE = 1.5;
// Usage is "dense" when active snapshots are never more than this far apart —
// something queries it about daily.
const DENSE_GAP_DAYS = 2;
// And "recent" when it was still being queried this close to the hide.
const DENSE_RECENT_DAYS = 3;

// What the caller knows about the cluster as a whole, which one index's history
// cannot say on its own.
export interface ObserveContext {
  // Earliest snapshot for this cluster — the moment we started watching. Null
  // when unknown, which disables every tenure-based rule.
  readonly watchingSince: string | null;
  readonly now: Date;
}

// The longest stretch between two consecutive sightings of this index, in days —
// the cadence the observe window has to be long enough to contain.
//
// Both kinds of stretch count, and observationGaps is the single place that knows
// what they are: the interval between two sightings inside a run, and the gap from
// one run's end to the next one's start. Taking a run's whole length instead would
// be the tempting mistake, and an expensive one in the direction that looks safe —
// a busy index whose counter happened to hold still for a fortnight would read as
// a fortnightly job and buy a month of extra observing for a verdict already in.
//
// Takes the sorted series, since the caller has one.
function largestSightingGapDays(sorted: readonly UsagePoint[]): number {
  return observationGaps(sorted).reduce((largest, gap) => Math.max(largest, gap.ms), 0) / DAY_MS;
}

// The observe window an index actually deserves, derived from its own usage
// history and its age instead of one flat number. Rules, in order — they do not
// overlap, since each names a different usage shape:
//
// The window does two jobs, and they set its length from opposite ends:
//
//   Will anything want this index again?  Answered at the cadence of the
//   workload — a monthly report needs a month of watching to say anything.
//   Did hiding it hurt?  Answered at the rate the index is QUERIED. A busy
//   index produces that verdict in hours; a rarely-used one may produce no
//   evidence at all in a month.
//
// Both point the same way for a sparse index — wait longer. They disagree for
// a busy one, and there the second wins: no amount of extra waiting adds
// evidence that arrived on the first day.
//
// - PERIODIC usage (a monthly report, a weekly batch): the fixed window can
//   expire between two runs and drop an index the next run needs. Extend to
//   2× the largest gap between active snapshots, so at least one full cycle
//   fits inside the window. Checked first, so a quarterly job that runs
//   densely for a week is read as periodic rather than as busy.
// - STILL BUSY (queried about daily, and up to the moment we hide it — a
//   redundant index serving live traffic): hiding it is an experiment that
//   reports back immediately, because the queries are already arriving.
//   Waiting a month past the first day adds no evidence, only exposure.
//   Shorten to the floor.
//
//   Note how narrow "still" is: an index that WAS busy and went quiet a week
//   ago gets no fast verdict from hiding it, since nothing is querying it to
//   notice. There the question is back to whether the workload returns, which
//   is a cadence question, and the rules below answer it by waiting.
// - VETERAN (used at some point, and part of the schema far longer than the
//   policy window): whatever wanted it may want it again on a cadence longer
//   than anything we have watched. Extend. Only reached when usage was NOT
//   dense — tenure is a proxy for "we might be missing a cadence", and it has
//   nothing to say once the index is being queried every day.
// - LONG-PROVEN IDLE (flat zero across history much longer than the policy
//   window): the history already is the observation — shorten to half the
//   policy (never under a week).
// - BORN HERE, NEVER USED (appeared while we were watching and has not been
//   touched since): the signature of an index someone created by hand and
//   forgot. Its whole life is on record, so observe roughly as long as it has
//   existed rather than a flat month — floored at a week, never longer than
//   the policy.
// - Anything else: the policy baseline.
//
// Age only counts when the index appeared AFTER we started watching. Snapshots
// begin at onboarding, so an index present in the first one may be five years
// old; `watchingSince` is what tells the two apart.
//
// The result is decided ONCE at hide time and stored on the recommendation,
// so the pending drop is predictable and auditable.
export function dynamicObserveDays(
  history: readonly UsagePoint[],
  policyDays: number,
  context: ObserveContext = { watchingSince: null, now: new Date() },
): ObserveWindow {
  const sorted = sortedRuns(history);
  const active = sorted.filter((point) => point.ops > 0);

  // Days since the index first appeared in a snapshot, but only when we were
  // already watching the cluster a clear margin before that.
  const first = sorted[0];
  const watchStart =
    context.watchingSince === null ? null : new Date(context.watchingSince).getTime();
  let knownTenureDays: number | null = null;
  if (first !== undefined && watchStart !== null && Number.isFinite(watchStart)) {
    const firstSeen = spanStart(first);
    if (firstSeen - watchStart >= TENURE_MARGIN_DAYS * DAY_MS) {
      knownTenureDays = (context.now.getTime() - firstSeen) / DAY_MS;
    }
  }

  // Two sightings, not two rows: a run of one row can hold a hundred of them.
  if (totalObservations(active) >= 2) {
    const largestGap = largestSightingGapDays(active);
    const gapDays = Math.ceil(largestGap);
    const extended = Math.min(2 * gapDays, Math.max(EXTEND_CAP_DAYS, policyDays));
    if (extended > policyDays) {
      return {
        days: extended,
        reason: `periodic usage with gaps up to ${gapDays} days — window extended to cover a full cycle`,
      };
    }

    // Reached only when the gaps were too small to be a cadence worth waiting
    // out. Both conditions matter: dense usage means a verdict arrives fast,
    // and recent usage means there is still traffic to deliver it. Drop either
    // and hiding the index tells us nothing quickly.
    const lastActive = active.at(-1);
    // How long since it was last CONFIRMED busy, so the end of the run rather
    // than its start. Measuring from the start would age a still-running index by
    // however long its counter had been steady and cost it the fast verdict.
    const quietDays =
      lastActive === undefined
        ? Number.POSITIVE_INFINITY
        : (context.now.getTime() - spanEnd(lastActive)) / DAY_MS;
    if (largestGap <= DENSE_GAP_DAYS && quietDays <= DENSE_RECENT_DAYS) {
      // Returns even when it cannot shorten — a tight policy is already at or
      // below the floor. This is a positive finding, not a failed attempt at
      // one: a still-busy index needs no extension, and falling through would
      // let the veteran rule stretch the window on tenure alone.
      const days = Math.min(SHORTEN_FLOOR_DAYS, policyDays);
      return {
        days,
        reason:
          days < policyDays
            ? `queried steadily and still in use — at that rate a regression shows up within ` +
              `days of hiding it, so the window is shortened rather than left open`
            : null,
      };
    }
  }

  // Used at some point, and older than the schema churn around it. The cadence
  // that wanted it may be longer than anything we have on record.
  if (
    active.length > 0 &&
    knownTenureDays !== null &&
    knownTenureDays >= LONG_TENURE_MULTIPLE * policyDays
  ) {
    const extended = Math.min(
      Math.max(EXTEND_CAP_DAYS, policyDays),
      Math.round(policyDays * VETERAN_MULTIPLE),
    );
    if (extended > policyDays) {
      return {
        days: extended,
        reason:
          `in place ${Math.floor(knownTenureDays)} days and used during that time — ` +
          `window extended before removing a long-standing index`,
      };
    }
  }

  if (active.length === 0 && totalObservations(sorted) >= 2) {
    const last = sorted.at(-1);
    if (first !== undefined && last !== undefined) {
      // First sighting to last confirmation — the whole span we watched it do
      // nothing, which for an index that never moved is one row.
      const spanDays = Math.floor((spanEnd(last) - spanStart(first)) / DAY_MS);
      if (spanDays >= 2 * policyDays) {
        const shortened = Math.max(
          Math.min(SHORTEN_FLOOR_DAYS, policyDays),
          Math.floor(policyDays / 2),
        );
        if (shortened < policyDays) {
          return {
            days: shortened,
            reason: `zero usage across ${spanDays} days of history — window shortened`,
          };
        }
      }
    }
  }

  // Created while we watched, never used since. Its entire life is on record,
  // so there is no hidden history to wait for — observe about as long as it has
  // existed instead of a flat month.
  if (active.length === 0 && knownTenureDays !== null) {
    const scaled = Math.max(
      Math.min(SHORTEN_FLOOR_DAYS, policyDays),
      Math.min(policyDays, Math.ceil(knownTenureDays)),
    );
    if (scaled < policyDays) {
      return {
        days: scaled,
        reason:
          `created ${Math.floor(knownTenureDays)} days ago and unused for its whole life — ` +
          `window shortened to match its age`,
      };
    }
  }

  return { days: policyDays, reason: null };
}
