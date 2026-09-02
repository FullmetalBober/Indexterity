// How long a regressed index stays parked, and what the dashboard proposes when
// a human parks one by hand.
//
// In `analysis/` rather than beside the writer in `jobs/cooldowns.ts`, because
// three places need the same curve and only one of them writes rows: the writer
// stamps `until` from it, `analysis/score.ts` fades the confidence penalty over
// the same span, and the api offers its first step as the default in the cancel
// dialog. Two copies of this arithmetic is two copies that can disagree about
// how long a block was — and the fade would then describe a window nobody was
// granted.

// How long the FIRST regression parks an index, as a multiple of the observe
// window it regressed during — and the floor on how short "short" can be (D136).
//
// One window, down from three. The instinct is to retry sooner, and there is a
// hard reason not to: the evidence for a drop is a usage history, and the reason
// it failed is that something used the index during the window. Retrying inside
// another window re-runs the same experiment against the same workload — hiding
// somebody's index again to learn what was already learnt. One window is the
// shortest span over which the answer can honestly have changed.
const FIRST_COOLDOWN_WINDOWS = 1;

// And then it doubles, where it used to be linear.
//
// 3x / 6x / 9x treated the third regression as three times the news of the
// first, and it is not: one regression says this drop was wrong, three say the
// engine is wrong about this index. Doubling says that better — but note what the
// numbers actually do, at the default 30-day window:
//
//   regressions    1     2     3     4     5     6
//   was (3x·n)    90d  180d  270d  360d  450d  540d
//   now (2^n)     30d   60d  120d  240d  365d  365d   <- capped
//
// The new curve is LOWER at every step, not shorter at first and longer later.
// Worth stating plainly, because the escalation makes it look otherwise: the cap
// arrives before the doubling ever overtakes the old line. That is the intended
// trade — the engine retries sooner, and it never parks an index for more than a
// year on its own. Longer than a year is a statement about the index rather than
// about one failed experiment, and that one is the owner's to make (an `until` of
// null), not the engine's.
//
// What keeps a repeat offender down is not this number alone: `regressionWeight`
// in analysis/score.ts docks the confidence score by the same count and fades it
// over the same span, so a twice-regressed index comes back eligible and still
// scores too low to auto-apply.
const COOLDOWN_CAP_DAYS = 365;

// Where an escalating cooldown lands, in days.
//
// Pure and tested directly, because the shape of the curve IS the decision — the
// rest of the cooldown code is bookkeeping around it.
export function cooldownDaysFor(observeDays: number, regressionCount: number): number {
  const windows = FIRST_COOLDOWN_WINDOWS * 2 ** Math.max(0, regressionCount - 1);
  return Math.min(COOLDOWN_CAP_DAYS, observeDays * windows);
}

// What the cancel dialog offers as its default: the span the engine would pick
// for its own first retry, so the number in the box is the engine's opinion
// rather than a round one somebody liked.
//
// It was a flat 90 days, and it was neither shown nor chosen — an owner who
// clicked Cancel once parked the index for a quarter without being told.
export function proposedVetoDays(observeDays: number): number {
  return cooldownDaysFor(observeDays, 1);
}
