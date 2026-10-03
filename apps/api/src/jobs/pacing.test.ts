import { describe, expect, it } from "vitest";
import {
  isDue,
  isPaced,
  MAX_TIER,
  nextTier,
  PASS_BUDGET_MS,
  pacedBudgetMs,
  pacedEveryHours,
} from "./pacing";

const MINUTE = 60_000;

describe("which passes are paced", () => {
  // The two that read the cluster every hour (#571, #588). The five-minute
  // passes are the fast signal, and apply and finalize have no budget at all.
  it("paces collect and suggest, and nothing else", () => {
    expect(["collect", "suggest"].every(isPaced)).toBe(true);
    expect(["classify", "probe", "apply", "finalize"].some(isPaced)).toBe(false);
  });
});

describe("a paced pass's pace", () => {
  // The invariant the whole design rests on: whatever the tier, a cluster may
  // take the same share of the one worker slot — five minutes an hour.
  it("stretches the budget and the interval by the same factor", () => {
    for (let tier = 0; tier <= MAX_TIER; tier++) {
      expect(pacedBudgetMs(tier) / (pacedEveryHours(tier) * 60 * MINUTE)).toBeCloseTo(
        PASS_BUDGET_MS / (60 * MINUTE),
        12,
      );
    }
    expect([0, 1, 2].map((tier) => pacedBudgetMs(tier))).toEqual([
      5 * MINUTE,
      10 * MINUTE,
      20 * MINUTE,
    ]);
    expect([0, 1, 2].map(pacedEveryHours)).toEqual([1, 2, 4]);
  });

  // A stored value outside the range — a hand edit, a future build that paced
  // further and was rolled back — reads as the nearest pace that exists.
  it("treats a tier outside the range as the nearest one", () => {
    expect(pacedBudgetMs(7)).toBe(pacedBudgetMs(MAX_TIER));
    expect(pacedEveryHours(-1)).toBe(1);
  });
});

describe("nextTier", () => {
  it("steps up a collect that ran out of time", () => {
    expect(nextTier(0, "timed-out", 5 * MINUTE)).toBe(1);
    expect(nextTier(1, "timed-out", 10 * MINUTE)).toBe(2);
  });

  // Capped: past four hours the change window has slots no reading's gap starts
  // in, and a longer collect would trip the queue alert (pacing.ts).
  it("stops at the furthest pace", () => {
    expect(nextTier(MAX_TIER, "timed-out", 20 * MINUTE)).toBe(MAX_TIER);
  });

  // It fitted, barely: the next slower hour is the one it does not.
  it("steps up a collect that landed close to its budget, before it fails", () => {
    expect(nextTier(0, "ok", 3.75 * MINUTE)).toBe(1);
    expect(nextTier(0, "ok", 3.7 * MINUTE)).toBe(0);
  });

  it("steps down once a paced collect fits in half the budget below", () => {
    expect(nextTier(1, "ok", 2.5 * MINUTE)).toBe(0);
    expect(nextTier(2, "ok", 5 * MINUTE)).toBe(1);
  });

  // The gap between the two lines is what stops a collect near a boundary from
  // flapping: stepped down to a budget it would use three quarters of, it would
  // step straight back up.
  it("holds a paced collect that fits but not with room to spare", () => {
    expect(nextTier(1, "ok", 4 * MINUTE)).toBe(1);
    expect(nextTier(1, "ok", 7 * MINUTE)).toBe(1);
  });

  // Being down says nothing about how long a collect takes.
  it.each([
    "unreachable",
    "tunnel-down",
    "credentials",
    "insecure",
    "unsupported",
    "error",
  ] as const)("leaves the pace alone when the collect ended %s", (outcome) => {
    expect(nextTier(1, outcome, 20 * MINUTE)).toBe(1);
    expect(nextTier(0, outcome, 20 * MINUTE)).toBe(0);
  });
});

describe("isDue", () => {
  const at = (iso: string) => new Date(iso);

  it("is always due for a cluster that is not paced", () => {
    expect(isDue(0, at("2026-10-01T12:00:30Z"), at("2026-10-01T12:05:00Z"))).toBe(true);
  });

  it("is due for a cluster with no collect on record", () => {
    expect(isDue(2, null, at("2026-10-01T12:05:00Z"))).toBe(true);
  });

  it("is due every second hour at the first pace, and every fourth at the second", () => {
    const started = at("2026-10-01T12:00:40Z");
    expect(isDue(1, started, at("2026-10-01T13:02:00Z"))).toBe(false);
    expect(isDue(1, started, at("2026-10-01T14:02:00Z"))).toBe(true);
    expect(isDue(2, started, at("2026-10-01T15:02:00Z"))).toBe(false);
    expect(isDue(2, started, at("2026-10-01T16:02:00Z"))).toBe(true);
  });

  // Counted in the schedule's hours, not elapsed time: a collect that started
  // forty minutes after its hour, because the queue was busy, is still due on the
  // occurrence two hours after the one it was dispatched on — not three.
  it("counts the schedule's hours, so a late start does not cost an occurrence", () => {
    expect(isDue(1, at("2026-10-01T12:40:00Z"), at("2026-10-01T14:01:00Z"))).toBe(true);
  });
});
