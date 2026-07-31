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

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / DAY_MS;
}

// The observe window an index actually deserves, derived from its own usage
// history instead of one flat number:
//
// - PERIODIC usage (a monthly report, a weekly batch): the fixed window can
//   expire between two runs and drop an index the next run needs. Extend to
//   2× the largest gap between active snapshots, so at least one full cycle
//   fits inside the window.
// - LONG-PROVEN IDLE (flat zero across history much longer than the policy
//   window): the history already is the observation — shorten to half the
//   policy (never under a week).
// - Anything else: the policy baseline.
//
// The result is decided ONCE at hide time and stored on the recommendation,
// so the pending drop is predictable and auditable.
export function dynamicObserveDays(
  history: readonly ObserveUsagePoint[],
  policyDays: number,
): ObserveWindow {
  const sorted = [...history].sort(
    (a, b) => new Date(a.capturedAt).getTime() - new Date(b.capturedAt).getTime(),
  );
  const active = sorted.filter((point) => point.ops > 0);

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

  if (active.length === 0 && sorted.length >= 2) {
    const first = sorted[0];
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

  return { days: policyDays, reason: null };
}
