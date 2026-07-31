export interface ObserveUsagePoint {
  readonly capturedAt: string;
  // Ops summed across replica-set members for that snapshot.
  readonly ops: number;
}

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

// What the caller knows about the cluster as a whole, which one index's history
// cannot say on its own.
export interface ObserveContext {
  // Earliest snapshot for this cluster — the moment we started watching. Null
  // when unknown, which disables every tenure-based rule.
  readonly watchingSince: string | null;
  readonly now: Date;
}

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / DAY_MS;
}

// The observe window an index actually deserves, derived from its own usage
// history and its age instead of one flat number. Rules, in order — they do not
// overlap, since each names a different usage shape:
//
// - PERIODIC usage (a monthly report, a weekly batch): the fixed window can
//   expire between two runs and drop an index the next run needs. Extend to
//   2× the largest gap between active snapshots, so at least one full cycle
//   fits inside the window.
// - VETERAN (used at some point, and part of the schema far longer than the
//   policy window): whatever wanted it may want it again on a cadence longer
//   than anything we have watched. Extend.
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
  history: readonly ObserveUsagePoint[],
  policyDays: number,
  context: ObserveContext = { watchingSince: null, now: new Date() },
): ObserveWindow {
  const sorted = [...history].sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime(),
  );
  const active = sorted.filter((point) => point.ops > 0);

  // Days since the index first appeared in a snapshot, but only when we were
  // already watching the cluster a clear margin before that.
  const first = sorted[0];
  const watchStart =
    context.watchingSince === null ? null : new Date(context.watchingSince).getTime();
  let knownTenureDays: number | null = null;
  if (first !== undefined && watchStart !== null && Number.isFinite(watchStart)) {
    const firstSeen = new Date(first.capturedAt).getTime();
    if (firstSeen - watchStart >= TENURE_MARGIN_DAYS * DAY_MS) {
      knownTenureDays = (context.now.getTime() - firstSeen) / DAY_MS;
    }
  }

  if (active.length >= 2) {
    let largestGap = 0;
    for (let i = 1; i < active.length; i++) {
      const prev = active[i - 1];
      const next = active[i];
      if (prev === undefined || next === undefined) continue;
      largestGap = Math.max(largestGap, daysBetween(prev.capturedAt, next.capturedAt));
    }
    const gapDays = Math.ceil(largestGap);
    const extended = Math.min(2 * gapDays, Math.max(EXTEND_CAP_DAYS, policyDays));
    if (extended > policyDays) {
      return {
        days: extended,
        reason: `periodic usage with gaps up to ${gapDays} days — window extended to cover a full cycle`,
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

  if (active.length === 0 && sorted.length >= 2) {
    const last = sorted.at(-1);
    if (first !== undefined && last !== undefined) {
      const spanDays = Math.floor(daysBetween(first.capturedAt, last.capturedAt));
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
