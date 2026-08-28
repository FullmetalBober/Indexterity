import { describe, expect, it } from "vitest";
import { dynamicObserveDays } from "./observe";
import { usageSeries } from "./usage";

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
    expect(series.reduce((sum, point) => sum + (point.observations ?? 0), 0)).toBe(720);
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

  it("counts a decrease with no since change in full, as the reset it is", () => {
    // A cumulative counter that shrank restarted, whatever `since` says — SQL
    // Server's ALTER INDEX REBUILD, or a Mongo row written before `since` was
    // persisted. The 5 is what has been served since, and it used to be clamped
    // to zero, which was safe only while a reset refused the whole history.
    // Now that a reset merely segments it, dropping the 5 would report an index
    // as idle over a stretch it was serving — so the counter is read the same
    // way a `since` move is read. Never negative either way.
    const series = usageSeries([run(20, 20, 1, 900), run(10, 10, 1, 5)]);
    expect(series.map((point) => point.ops)).toEqual([900, 5]);
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
