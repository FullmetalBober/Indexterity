import { describe, expect, it } from "vitest";
import { dynamicObserveDays, usageSeries } from "./observe";

function point(day: number, ops: number): { capturedAt: string; ops: number } {
  return { capturedAt: new Date(Date.UTC(2026, 0, 1 + day)).toISOString(), ops };
}

describe("dynamicObserveDays", () => {
  it("keeps the policy window when history is unremarkable", () => {
    const history = [point(0, 5), point(1, 3), point(2, 8)];
    expect(dynamicObserveDays(history, 30)).toEqual({ days: 30, reason: null });
  });

  it("extends to 2× the largest activity gap for periodic usage", () => {
    // Active on day 0, 20, 40 — a ~20-day cadence; 30 days could miss a cycle.
    const history = [point(0, 5), point(10, 0), point(20, 5), point(30, 0), point(40, 5)];
    const window = dynamicObserveDays(history, 30);
    expect(window.days).toBe(40);
    expect(window.reason).toContain("periodic usage");
  });

  it("caps the extension at 90 days", () => {
    const history = [point(0, 5), point(80, 5)];
    expect(dynamicObserveDays(history, 30).days).toBe(90);
  });

  it("never extends below the policy (small gaps change nothing)", () => {
    const history = [point(0, 5), point(2, 5), point(4, 5)];
    expect(dynamicObserveDays(history, 30)).toEqual({ days: 30, reason: null });
  });

  it("shortens for an index proven idle across 2× the policy window", () => {
    const history = [point(0, 0), point(30, 0), point(65, 0)];
    const window = dynamicObserveDays(history, 30);
    expect(window.days).toBe(15);
    expect(window.reason).toContain("zero usage across");
  });

  it("never shortens below a week, and never below a tighter policy", () => {
    const idle = [point(0, 0), point(100, 0)];
    expect(dynamicObserveDays(idle, 10).days).toBe(7);
    // A 5-day policy is already under the floor — unchanged.
    expect(dynamicObserveDays(idle, 5)).toEqual({ days: 5, reason: null });
  });

  it("does not shorten on thin history", () => {
    expect(dynamicObserveDays([point(0, 0)], 30)).toEqual({ days: 30, reason: null });
    expect(dynamicObserveDays([], 30)).toEqual({ days: 30, reason: null });
  });
});

// Day 0 is 2026-01-01; `at(day)` is a clock reading, `since(day)` the moment
// collection for the cluster began.
function at(day: number): Date {
  return new Date(Date.UTC(2026, 0, 1 + day));
}
function since(day: number): string {
  return at(day).toISOString();
}

describe("dynamicObserveDays — age", () => {
  it("shortens for an index created on our watch and never used", () => {
    // Watching from day 0; the index first appears on day 10 and is idle.
    const history = [point(10, 0), point(11, 0), point(12, 0)];
    const window = dynamicObserveDays(history, 30, { watchingSince: since(0), now: at(22) });
    expect(window.days).toBe(12);
    expect(window.reason).toContain("created 12 days ago");
  });

  it("floors that shortening at a week", () => {
    const history = [point(10, 0), point(11, 0)];
    const window = dynamicObserveDays(history, 30, { watchingSince: since(0), now: at(12) });
    expect(window.days).toBe(7);
  });

  it("will not call an index young just because we onboarded recently", () => {
    // The index is in the very first snapshot, so it predates our watching and
    // could be years old. No tenure claim, no shortening.
    const history = [point(0, 0), point(1, 0), point(2, 0)];
    expect(dynamicObserveDays(history, 30, { watchingSince: since(0), now: at(3) })).toEqual({
      days: 30,
      reason: null,
    });
  });

  it("makes no age claim without a watching-since", () => {
    const history = [point(10, 0), point(11, 0)];
    expect(dynamicObserveDays(history, 30, { watchingSince: null, now: at(12) })).toEqual({
      days: 30,
      reason: null,
    });
  });

  it("extends for a long-standing index that saw real use", () => {
    // Appeared on day 5, used early, quiet since, and now 90 days old.
    const history = [point(5, 12), point(20, 0), point(60, 0)];
    const window = dynamicObserveDays(history, 30, { watchingSince: since(0), now: at(95) });
    expect(window.days).toBe(45);
    expect(window.reason).toContain("in place 90 days");
  });

  it("prefers the periodic cadence over the veteran extension", () => {
    // Both rules match; the measured cadence is the more specific answer.
    const history = [point(5, 5), point(45, 5), point(85, 5)];
    const window = dynamicObserveDays(history, 30, { watchingSince: since(0), now: at(95) });
    expect(window.days).toBe(80);
    expect(window.reason).toContain("periodic usage");
  });

  it("prefers long-proven idleness over the age rule", () => {
    // 65 days of watched silence is stronger evidence than the index's age.
    const history = [point(5, 0), point(35, 0), point(70, 0)];
    const window = dynamicObserveDays(history, 30, { watchingSince: since(0), now: at(75) });
    expect(window.days).toBe(15);
    expect(window.reason).toContain("zero usage across");
  });
});

// The window answers two questions, and they set its length from opposite
// ends: "will anything want this again" runs at the cadence of the workload,
// "did hiding it hurt" runs at the rate the index is queried. Only the first
// was implemented, so an index being queried every second was watched LONGER
// than one queried monthly.
describe("dynamicObserveDays — still-busy indexes", () => {
  const now = new Date("2026-08-02T00:00:00Z");
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const context = { watchingSince: day(300), now };

  const daily = (count: number, quietTail = 0) =>
    Array.from({ length: count }, (_, i) => ({
      capturedAt: day(count - i),
      ops: i < count - quietTail ? 5000 : 0,
    }));

  // The redundant-drop case: the index is serving traffic right now, and
  // another index covers it. Hiding it moves that traffic, and the latency
  // gate sees the result the same day.
  it("shortens for an index still being queried at the moment of the hide", () => {
    const window = dynamicObserveDays(daily(60), 30, context);
    expect(window.days).toBe(7);
    expect(window.reason).toContain("still in use");
  });

  // Tenure is a proxy for "there may be a cadence we have not seen". Once the
  // index is queried every day there is no unseen cadence, so it must not win.
  it("beats the veteran extension, which would have watched it for 45 days", () => {
    expect(dynamicObserveDays(daily(60), 30, context).days).toBeLessThan(30);
  });

  // "Still" is narrow on purpose. Nothing is querying this one any more, so
  // hiding it produces no verdict quickly — the question is whether the
  // workload comes back, and that is answered by waiting.
  it("does not shorten once the traffic has stopped", () => {
    expect(dynamicObserveDays(daily(60, 8), 30, context).days).toBeGreaterThanOrEqual(30);
  });

  // A quarterly job runs densely for a week at a time. Dense, but the gaps
  // between bursts are the whole point, so periodic has to be checked first.
  it("leaves a quarterly burst to the periodic rule", () => {
    const burst = [
      ...Array.from({ length: 7 }, (_, i) => ({ capturedAt: day(97 - i), ops: 900 })),
      ...Array.from({ length: 7 }, (_, i) => ({ capturedAt: day(7 - i), ops: 900 })),
    ];
    const window = dynamicObserveDays(burst, 30, context);
    expect(window.days).toBeGreaterThan(30);
    expect(window.reason).toContain("periodic");
  });

  // A tight policy is already at or below the floor, so there is nothing to
  // shorten — but the finding still has to stop the veteran rule extending it.
  it("holds a policy that is already tighter than the floor", () => {
    const window = dynamicObserveDays(daily(60), 5, context);
    expect(window.days).toBe(5);
    expect(window.reason).toBeNull();
  });
  // Run-length storage. The window is decided from the index's own history, and
  // that history is now intervals rather than instants.
  describe("over run-length readings", () => {
    it("does not read a quiet run as a periodic cadence", () => {
      // A busy index whose op counter happened to hold still for a fortnight.
      // Taking the run's whole length as the gap between sightings would call it
      // a fortnightly job and buy a month of extra observing for a verdict that
      // is already in — the mistake that looks conservative and is not.
      const history = [
        { capturedAt: day(20), lastSeenAt: day(6), observations: 57, ops: 900 },
        { capturedAt: day(5), lastSeenAt: day(0), observations: 21, ops: 1500 },
      ];
      const window = dynamicObserveDays(history, 30, context);
      expect(window.days).toBe(7);
      expect(window.reason).toContain("queried steadily");
    });

    it("measures quiet time from the last confirmation, not the run's start", () => {
      // Confirmed busy right up to now, in one row that started three weeks ago.
      // Measuring from capturedAt would age it by the run's length and cost it
      // the fast verdict a still-busy index has earned.
      const history = [{ capturedAt: day(21), lastSeenAt: day(0), observations: 85, ops: 900 }];
      expect(dynamicObserveDays(history, 30, context).days).toBe(7);
    });

    it("counts a single long idle run as the span it covers", () => {
      // Ninety days of nothing, in one row. The shortening rule wants a span at
      // least twice the policy window, and reading one row as one sample would
      // have withheld it.
      const history = [{ capturedAt: day(90), lastSeenAt: day(0), observations: 361, ops: 0 }];
      const window = dynamicObserveDays(history, 30, context);
      expect(window.days).toBe(15);
      expect(window.reason).toContain("zero usage across");
    });

    it("still finds a real cadence in the gaps between runs", () => {
      // A monthly job: each burst is its own run, and the month between them is
      // a genuine gap. The periodic rule has to keep firing.
      const history = [
        { capturedAt: day(64), lastSeenAt: day(63), observations: 5, ops: 100 },
        { capturedAt: day(32), lastSeenAt: day(31), observations: 5, ops: 200 },
        { capturedAt: day(1), lastSeenAt: day(0), observations: 5, ops: 300 },
      ];
      const window = dynamicObserveDays(history, 30, context);
      expect(window.days).toBeGreaterThan(30);
      expect(window.reason).toContain("periodic");
    });
  });
});

// The counters as they are actually stored (#263). `$indexStats.accesses.ops` is
// cumulative and `collect` run-length-encodes it, so a stored run is "the counter
// read X for this whole span" — which is a statement about SILENCE everywhere
// except its first instant. Reading it as activity is what let an index queried
// once a month report itself as one queried continuously.
describe("usageSeries", () => {
  const now = new Date("2026-08-20T00:00:00.000Z");
  const day = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();
  const context = { watchingSince: day(400), now };
  const member = (ops: number, since = "s1") => [{ member: "h1", ops, since }];

  const run = (from: number, to: number, observations: number, ops: number, since = "s1") => ({
    capturedAt: day(from),
    lastSeenAt: day(to),
    observations,
    maxGapMs: 3_600_000,
    perMember: member(ops, since),
  });

  it("splits a run that moved into its activity and the silence after it", () => {
    // The counter jumped at day 30 and then sat still for a month.
    const series = usageSeries([run(30, 0, 720, 900)]);
    expect(series).toHaveLength(2);
    expect(series[0]).toMatchObject({ capturedAt: day(30), lastSeenAt: day(30), ops: 900 });
    expect(series[1]).toMatchObject({ capturedAt: day(30), lastSeenAt: day(0), ops: 0 });
    // Collects are preserved across the split — the thresholds downstream are
    // phrased in them.
    expect(series[0].observations + series[1].observations).toBe(720);
  });

  it("leaves a run that never moved as one idle reading over its whole span", () => {
    const series = usageSeries([run(90, 0, 2160, 0)]);
    expect(series).toHaveLength(1);
    expect(series[0]).toMatchObject({
      capturedAt: day(90),
      lastSeenAt: day(0),
      observations: 2160,
      ops: 0,
    });
  });

  it("differences consecutive runs rather than reading the counter as activity", () => {
    const series = usageSeries([run(60, 31, 720, 200), run(30, 0, 720, 300)]);
    expect(series.filter((point) => point.ops > 0).map((point) => point.ops)).toEqual([200, 100]);
  });

  it("counts a restarted counter in full instead of as a negative difference", () => {
    // `since` moved, so the 5 is everything that happened after the restart —
    // not 5 - 900, and not zero.
    const series = usageSeries([run(20, 20, 1, 900), run(10, 10, 1, 5, "s2")]);
    expect(series.map((point) => point.ops)).toEqual([900, 5]);
  });

  it("treats a decrease with no since change as an unseen reset, never as negative", () => {
    const series = usageSeries([run(20, 20, 1, 900), run(10, 10, 1, 5)]);
    expect(series.map((point) => point.ops)).toEqual([900, 0]);
  });

  it("counts a member that appeared in full and one that vanished not at all", () => {
    const series = usageSeries([
      { ...run(20, 20, 1, 100), perMember: [{ member: "h1", ops: 100, since: "s1" }] },
      {
        ...run(10, 10, 1, 0),
        perMember: [
          { member: "h1", ops: 100, since: "s1" },
          { member: "h2", ops: 40, since: "s1" },
        ],
      },
      { ...run(5, 5, 1, 0), perMember: [{ member: "h2", ops: 40, since: "s1" }] },
    ]);
    expect(series.map((point) => point.ops)).toEqual([100, 40, 0]);
  });

  // The bug in #263, end to end. Both histories are 30 days of hourly collects;
  // one index was queried throughout and the other was queried once, on the
  // first day. Before this they were arithmetically identical and both were
  // handed a 7-day window.
  describe("through dynamicObserveDays", () => {
    it("does not call an index busy because its counter is merely still readable", () => {
      const window = dynamicObserveDays(usageSeries([run(30, 0, 720, 900)]), 30, context);
      expect(window).toEqual({ days: 30, reason: null });
    });

    it("still shortens for one that is genuinely being queried", () => {
      const busy = Array.from({ length: 720 }, (_, i) => {
        const at = day(30 - i / 24);
        return {
          capturedAt: at,
          lastSeenAt: at,
          observations: 1,
          maxGapMs: 0,
          perMember: member(900 + i),
        };
      });
      const window = dynamicObserveDays(usageSeries(busy), 30, context);
      expect(window.days).toBe(7);
      expect(window.reason).toContain("still in use");
    });

    // The periodic rule was unreachable for the shape it was written for: a
    // monthly job leaves the counter flat between its runs, so the runs are
    // contiguous and there was no gap left to measure.
    it("finds the cadence of a monthly job, which no longer hides behind flat runs", () => {
      const monthly = [run(90, 61, 696, 100), run(60, 31, 696, 200), run(30, 0, 720, 300)];
      const window = dynamicObserveDays(usageSeries(monthly), 30, context);
      expect(window.days).toBe(60);
      expect(window.reason).toContain("periodic usage");
    });

    it("keeps shortening for an index proven idle across the whole history", () => {
      const window = dynamicObserveDays(usageSeries([run(90, 0, 2160, 0)]), 30, context);
      expect(window.days).toBe(15);
      expect(window.reason).toContain("zero usage across");
    });
  });
});
