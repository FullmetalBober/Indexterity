import { describe, expect, it } from "vitest";
import { at } from "../errors/at";
import {
  classifyUsage,
  counterEpochs,
  trustedWatchMs,
  usageHistoryIsTrustworthy,
  usageTrustRefusal,
} from "./classify";
import type { UsageSnapshot } from "./types";

// Snapshots at a given cadence, oldest first — because classifyUsage now reads
// the clock rather than counting rows, a fixture where every snapshot shares a
// timestamp cannot express "went quiet".
//
// Each entry is the ACTIVITY in that interval, which is what every case below
// is really describing, and the helper accumulates it into the cumulative
// counter mongod would actually report (#265). Stating the fixtures as
// activity and storing them as counters is the whole shape of the bug in one
// function: `[5, 0, 0, 3]` is one burst, a quiet spell and another burst, and
// it reaches classifyUsage as 5, 5, 5, 8.
function series(activityPerSnapshot: readonly number[], hoursApart = 6): UsageSnapshot[] {
  let counter = 0;
  return activityPerSnapshot.map((activity, i) => {
    counter += activity;
    return {
      capturedAt: new Date(Date.UTC(2026, 0, 1, i * hoursApart)).toISOString(),
      perMember: [{ member: "m", ops: counter, since: "2026-01-01T00:00:00Z" }],
    };
  });
}

const options = {
  recentHours: 12,
  minHistory: 3,
  minHistoryDays: 0,
  minActiveHours: 0,
  maxGapHours: 48,
};

describe("classifyUsage", () => {
  it("FLAT_ZERO below minHistory", () => {
    expect(classifyUsage(series([5, 5]), options)).toBe("FLAT_ZERO");
  });
  it("FLAT_ZERO when every snapshot is idle", () => {
    expect(classifyUsage(series([0, 0, 0]), options)).toBe("FLAT_ZERO");
  });
  it("CONTINUOUS when every snapshot is active", () => {
    expect(classifyUsage(series([1, 2, 3]), options)).toBe("CONTINUOUS");
  });
  it("PERIODIC_ALIVE when the recent window still fires", () => {
    expect(classifyUsage(series([5, 0, 0, 3]), options)).toBe("PERIODIC_ALIVE");
  });
  it("PERIODIC_DEAD when it fired once then went quiet", () => {
    expect(classifyUsage(series([5, 0, 0, 0]), options)).toBe("PERIODIC_DEAD");
  });
  it("sums activity across replica-set members", () => {
    // Neither member is busy on its own every interval; between them the index
    // is served at every look, which is what CONTINUOUS means.
    const split = series([0, 0, 0]).map((snapshot, i) => ({
      ...snapshot,
      perMember: [
        { member: "a", ops: i + 1, since: "" },
        { member: "b", ops: 4 * (i + 1), since: "" },
      ],
    }));
    expect(classifyUsage(split, options)).toBe("CONTINUOUS");
  });

  // The reason recentHours is hours. recentWindow:3 meant "the last twelve
  // hours" only while snapshots were six hours apart; at fifteen minutes the same
  // three snapshots were forty-five minutes, and a nightly job that had not run
  // yet today read as PERIODIC_DEAD — which is the droppable class.
  //
  // Same traffic, same verdict, whatever the cadence.
  it.each([
    ["6h", 6],
    ["1h", 1],
    ["15m", 0.25],
  ])("calls a burst inside the recent window ALIVE at a %s cadence", (_label, hours) => {
    // Fires in the newest snapshot, whatever the spacing.
    const history = series([5, 0, 0, 3], hours);
    expect(classifyUsage(history, options)).toBe("PERIODIC_ALIVE");
  });

  it("calls a burst older than the recent window DEAD at every cadence", () => {
    // 40 snapshots six hours apart: the burst is ten days back, far outside 12h.
    const long = series([5, ...Array.from({ length: 39 }, () => 0)]);
    expect(classifyUsage(long, options)).toBe("PERIODIC_DEAD");
    // The same shape at fifteen minutes is only ten hours, so the burst is still
    // inside the window and the index is still alive. Counting snapshots could
    // not tell these two apart; hours can.
    const short = series([5, ...Array.from({ length: 39 }, () => 0)], 0.25);
    expect(classifyUsage(short, options)).toBe("PERIODIC_ALIVE");
  });
});

// #265. The counters are cumulative and stored raw, so "this snapshot reports
// ops" was true of every index used even once since the member's `since` — and
// CONTINUOUS, the one class that means "in constant use", was the verdict on an
// index that had served nothing for months. CONTINUOUS is not droppable, so the
// dead index with the clearest evidence was the one that could never be
// proposed.
describe("classifyUsage — cumulative counters", () => {
  const now = Date.UTC(2026, 2, 1);
  const day = (n: number) => new Date(now - n * 86_400_000).toISOString();
  const opts = { ...options, recentHours: 72, minHistory: 3 };

  // Run-length storage as collect actually writes it: the counter moved once,
  // sixty days ago, and every collect since has extended one unchanging row.
  const frozenAfterOneUse = [
    {
      capturedAt: day(60),
      lastSeenAt: day(60),
      observations: 1,
      maxGapMs: 0,
      perMember: [{ member: "m", ops: 900, since: "s1" }],
    },
    {
      capturedAt: day(59),
      lastSeenAt: day(0),
      observations: 1416,
      maxGapMs: 3_600_000,
      perMember: [{ member: "m", ops: 900, since: "s1" }],
    },
  ];

  it("does not call an index continuous because its counter is merely non-zero", () => {
    expect(classifyUsage(frozenAfterOneUse, opts)).toBe("PERIODIC_DEAD");
  });

  it("still calls an index continuous when the counter moves at every look", () => {
    const moving = Array.from({ length: 10 }, (_, i) => ({
      capturedAt: day(10 - i),
      perMember: [{ member: "m", ops: 100 * (i + 1), since: "s1" }],
    }));
    expect(classifyUsage(moving, opts)).toBe("CONTINUOUS");
  });

  it("keeps FLAT_ZERO for a counter that never moved at all", () => {
    const never = [
      {
        capturedAt: day(60),
        lastSeenAt: day(0),
        observations: 1440,
        maxGapMs: 3_600_000,
        perMember: [{ member: "m", ops: 0, since: "s1" }],
      },
    ];
    expect(classifyUsage(never, opts)).toBe("FLAT_ZERO");
  });

  it("calls a burst inside the recent window alive, dated to when the counter jumped", () => {
    const recent = [
      {
        capturedAt: day(30),
        lastSeenAt: day(2),
        observations: 672,
        maxGapMs: 3_600_000,
        perMember: [{ member: "m", ops: 900, since: "s1" }],
      },
      {
        capturedAt: day(1),
        lastSeenAt: day(0),
        observations: 24,
        maxGapMs: 3_600_000,
        perMember: [{ member: "m", ops: 1500, since: "s1" }],
      },
    ];
    expect(classifyUsage(recent, opts)).toBe("PERIODIC_ALIVE");
  });

  // A restart resets the counter, so the reading after it is everything that
  // happened since — never a negative difference, and never silence.
  it("reads a restarted counter as the activity it reports, not as a decrease", () => {
    const restarted = [
      {
        capturedAt: day(10),
        perMember: [{ member: "m", ops: 5000, since: "s1" }],
      },
      {
        capturedAt: day(5),
        perMember: [{ member: "m", ops: 40, since: "s2" }],
      },
      {
        capturedAt: day(1),
        perMember: [{ member: "m", ops: 80, since: "s2" }],
      },
    ];
    expect(classifyUsage(restarted, opts)).toBe("CONTINUOUS");
  });
});

describe("usageHistoryIsTrustworthy", () => {
  const opts = {
    recentHours: 12,
    minHistory: 3,
    minHistoryDays: 0,
    minActiveHours: 0,
    maxGapHours: 48,
  };
  const at = (iso: string, ops = 0): UsageSnapshot => ({
    capturedAt: iso,
    perMember: [{ member: "m", ops, since: "" }],
  });
  const now = new Date("2026-03-04T00:00:00Z");

  it("accepts a dense, current series", () => {
    const history = [
      at("2026-03-01T00:00:00Z"),
      at("2026-03-02T00:00:00Z"),
      at("2026-03-03T12:00:00Z"),
    ];
    expect(usageHistoryIsTrustworthy(history, opts, now)).toBe(true);
  });

  it("rejects history thinner than minHistory", () => {
    expect(usageHistoryIsTrustworthy([at("2026-03-03T00:00:00Z")], opts, now)).toBe(false);
  });

  it("rejects a series with a hole in it — the outage case", () => {
    // Collected, went dark for three weeks, came back: an index that was busy
    // through the gap looks identical to a dead one.
    const history = [
      at("2026-02-01T00:00:00Z"),
      at("2026-02-02T00:00:00Z"),
      at("2026-03-03T00:00:00Z"),
    ];
    expect(usageHistoryIsTrustworthy(history, opts, now)).toBe(false);
  });

  it("rejects a series that stopped long ago, even if it was dense", () => {
    const history = [
      at("2026-01-01T00:00:00Z"),
      at("2026-01-02T00:00:00Z"),
      at("2026-01-03T00:00:00Z"),
    ];
    expect(usageHistoryIsTrustworthy(history, opts, now)).toBe(false);
  });

  it("does not care about ordering of the input", () => {
    const history = [
      at("2026-03-03T00:00:00Z"),
      at("2026-03-01T00:00:00Z"),
      at("2026-03-02T00:00:00Z"),
    ];
    expect(usageHistoryIsTrustworthy(history, opts, now)).toBe(true);
  });

  // A run says "unchanged throughout", so a hole INSIDE one is invisible to the
  // between-runs check — the gate would read a single row spanning an outage as a
  // month of diligent watching. The collector refuses to build such a run, and
  // these are about not having to take its word for it.
  it("rejects a run whose own interior has a hole in it", () => {
    const history: UsageSnapshot[] = [
      {
        capturedAt: "2026-02-01T00:00:00Z",
        lastSeenAt: "2026-03-03T00:00:00Z",
        observations: 100,
        // Somewhere in that month we went dark for three weeks. Evenly spaced, the
        // interior would look like eight-hour intervals and pass.
        maxGapMs: 21 * 24 * 3_600_000,
        perMember: [{ member: "m", ops: 0, since: "" }],
      },
    ];
    expect(usageHistoryIsTrustworthy(history, opts, now)).toBe(false);
  });

  it("accepts a long quiet run that really was watched throughout", () => {
    const history: UsageSnapshot[] = [
      {
        capturedAt: "2026-02-01T00:00:00Z",
        lastSeenAt: "2026-03-03T00:00:00Z",
        observations: 124,
        // The 6h cadence, with one missed collect. Exactly the case run-length
        // storage exists to make cheap, and it must still be droppable.
        maxGapMs: 12 * 3_600_000,
        perMember: [{ member: "m", ops: 0, since: "" }],
      },
    ];
    expect(usageHistoryIsTrustworthy(history, opts, now)).toBe(true);
  });

  it("trusts a run that cannot say, which is every row written before the column", () => {
    // Absent maxGapMs reads as zero rather than as suspicious: the alternative
    // fails closed on the entire existing history and stops the engine proposing
    // anything until a year of rows has rolled over.
    const history: UsageSnapshot[] = [
      {
        capturedAt: "2026-02-01T00:00:00Z",
        lastSeenAt: "2026-03-03T00:00:00Z",
        observations: 124,
        perMember: [{ member: "m", ops: 0, since: "" }],
      },
    ];
    expect(usageHistoryIsTrustworthy(history, opts, now)).toBe(true);
  });
});

describe("counterEpochs", () => {
  const snap = (
    day: number,
    members: Array<{ member: string; ops: number; since?: string }>,
  ): UsageSnapshot => ({
    capturedAt: `2026-03-0${day}T00:00:00Z`,
    perMember: members,
  });
  const OLD = "2026-01-01T00:00:00Z";
  const DAY = 24 * 3_600_000;
  const hours = (history: UsageSnapshot[]): number[] =>
    counterEpochs(history).map((epoch) => (epoch.endMs - epoch.startMs) / 3_600_000);

  it("is one unbroken epoch when every counter predates the window and never moves", () => {
    const history = [
      snap(1, [{ member: "a", ops: 0, since: OLD }]),
      snap(2, [{ member: "a", ops: 0, since: OLD }]),
      snap(3, [{ member: "a", ops: 0, since: OLD }]),
    ];
    expect(hours(history)).toEqual([48]);
    expect(trustedWatchMs(history)).toBe(2 * DAY);
  });

  it("splits where a member's counter start jumped forward, and counts both halves", () => {
    const history = [
      snap(1, [{ member: "a", ops: 500, since: OLD }]),
      snap(2, [{ member: "a", ops: 500, since: OLD }]),
      // Restarted: counter start moves up and ops begin again at zero.
      snap(3, [{ member: "a", ops: 0, since: "2026-03-02T18:00:00Z" }]),
    ];
    // Day 1 to day 2 is watched; the restart ends it; day 3 is a fresh epoch of
    // no length yet. The 18:00-to-day-3 blind window is nobody's observation and
    // is credited to neither.
    expect(hours(history)).toEqual([24, 0]);
  });

  it("splits on one restarted member among several healthy ones", () => {
    const history = [
      snap(1, [
        { member: "a", ops: 10, since: OLD },
        { member: "b", ops: 10, since: OLD },
      ]),
      snap(3, [
        { member: "a", ops: 10, since: OLD },
        { member: "b", ops: 0, since: "2026-03-02T00:00:00Z" },
      ]),
    ];
    expect(counterEpochs(history)).toHaveLength(2);
  });

  it("dates the first epoch from its counters when they are younger than the history", () => {
    // Three days of snapshots, but the counter only started midway through the
    // second: it cannot testify that the index was idle for the days before it.
    // No boundary is visible here — there is no earlier snapshot to have seen it
    // — so the clamp is the only thing standing between this and a false claim
    // of three days' watching.
    const history = [
      snap(1, [{ member: "a", ops: 0, since: "2026-03-02T12:00:00Z" }]),
      snap(2, [{ member: "a", ops: 0, since: "2026-03-02T12:00:00Z" }]),
      snap(3, [{ member: "a", ops: 0, since: "2026-03-02T12:00:00Z" }]),
    ];
    expect(hours(history)).toEqual([12]);
  });

  it("splits on a cumulative counter that went backwards, even when since holds still", () => {
    // The SQL Server trap (#36): ALTER INDEX REBUILD zeroes the index's usage
    // row without the service restarting, so `since` — the server start —
    // never moves. Verified on 2022 CU24. A counter cannot shrink; one that
    // did restarted.
    const history = [
      snap(1, [{ member: "a", ops: 500, since: OLD }]),
      snap(2, [{ member: "a", ops: 520, since: OLD }]),
      snap(3, [{ member: "a", ops: 0, since: OLD }]),
    ];
    expect(hours(history)).toEqual([24, 0]);
  });

  it("splits on a backwards counter on legacy rows with no since at all", () => {
    const history = [
      snap(1, [{ member: "a", ops: 300 }]),
      snap(2, [{ member: "a", ops: 40 }]),
      snap(3, [{ member: "a", ops: 45 }]),
    ];
    // The first epoch is one lone reading, so it spans nothing — a rate needs
    // two — and only the pair after the rebuild is watch time.
    expect(hours(history)).toEqual([0, 24]);
  });

  it("does not read ordinary growth as a restart", () => {
    const history = [
      snap(1, [{ member: "a", ops: 100, since: OLD }]),
      snap(2, [{ member: "a", ops: 100, since: OLD }]),
      snap(3, [{ member: "a", ops: 260, since: OLD }]),
    ];
    expect(hours(history)).toEqual([48]);
  });

  it("is one epoch when snapshots predate the field (legacy rows)", () => {
    const history = [
      snap(1, [{ member: "a", ops: 0 }]),
      snap(2, [{ member: "a", ops: 0 }]),
      snap(3, [{ member: "a", ops: 0 }]),
    ];
    expect(hours(history)).toEqual([48]);
  });

  // The measurement the whole change came from: a cluster restarting nightly,
  // where the old rule discarded 74.9 hours of observation to avoid 1.6 hours
  // of blindness, and went on discarding it for as long as the restarts lasted.
  it("accumulates watch time across nightly restarts instead of refusing forever", () => {
    const at = (iso: string, ops: number, since: string): UsageSnapshot => ({
      capturedAt: iso,
      perMember: [{ member: "mongodb-0:27017", ops, since }],
    });
    const history = [
      at("2026-08-25T08:50:00Z", 0, "2026-08-25T01:42:07Z"),
      at("2026-08-27T00:00:00Z", 0, "2026-08-25T01:42:07Z"),
      at("2026-08-27T01:01:00Z", 0, "2026-08-27T00:57:19Z"),
      at("2026-08-28T01:00:00Z", 0, "2026-08-27T00:57:19Z"),
      at("2026-08-28T02:00:00Z", 0, "2026-08-28T01:44:15Z"),
      at("2026-08-28T13:41:00Z", 0, "2026-08-28T01:44:15Z"),
    ];
    const watched = hours(history);
    expect(watched.map((h) => Math.round(h * 10) / 10)).toEqual([39.2, 24, 11.7]);
    // Nothing like the wall-clock span, and nothing like the zero it used to be.
    expect(Math.round(trustedWatchMs(history) / 3_600_000)).toBe(75);
  });
});

describe("usageHistoryIsTrustworthy with restart evidence", () => {
  const opts = {
    recentHours: 12,
    minHistory: 3,
    minHistoryDays: 0,
    minActiveHours: 0,
    maxGapHours: 48,
  };
  const now = new Date("2026-03-04T00:00:00Z");
  const history = (since: string[]): UsageSnapshot[] =>
    since.map((value, i) => ({
      capturedAt: `2026-03-0${i + 1}T00:00:00Z`,
      perMember: [{ member: "a", ops: 0, since: value }],
    }));

  it("trusts a dense window whose counters outlive it", () => {
    expect(
      usageHistoryIsTrustworthy(
        history(["2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]),
        opts,
        now,
      ),
    ).toBe(true);
  });

  it("still trusts it once a restart lands inside it", () => {
    // minHistoryDays is 0 here, so what this asserts is that the restart itself
    // no longer refuses: the epochs either side are read, not thrown away.
    expect(
      usageHistoryIsTrustworthy(
        history(["2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-03-02T06:00:00Z"]),
        opts,
        now,
      ),
    ).toBe(true);
  });

  it("charges the restart for the watch time it cost, against the warm-up", () => {
    // Two days of snapshots either side of a restart on day 2. Asking for two
    // days of watching fails, because the epochs sum to less than that; asking
    // for one passes, because what WAS watched still counts.
    const restarted = history([
      "2026-01-01T00:00:00Z",
      "2026-01-01T00:00:00Z",
      "2026-03-02T06:00:00Z",
    ]);
    expect(usageHistoryIsTrustworthy(restarted, { ...opts, minHistoryDays: 2 }, now)).toBe(false);
    expect(usageHistoryIsTrustworthy(restarted, { ...opts, minHistoryDays: 1 }, now)).toBe(true);
  });
});

describe("warm-up: history span, not just snapshot count", () => {
  const opts = {
    recentHours: 12,
    minHistory: 3,
    minHistoryDays: 7,
    minActiveHours: 0,
    maxGapHours: 48,
  };
  // A freshly connected cluster collecting every 6h.
  const collects = (count: number, fromDay: number): UsageSnapshot[] =>
    Array.from({ length: count }, (_, i) => ({
      capturedAt: new Date(Date.UTC(2026, 0, fromDay, i * 6)).toISOString(),
      perMember: [{ member: "m", ops: 0, since: "2026-01-01T00:00:00Z" }],
    }));

  it("refuses a usage claim on a cluster connected yesterday", () => {
    // Three snapshots, eighteen hours — enough to count, not enough to know.
    const history = collects(4, 1);
    const now = new Date(Date.UTC(2026, 0, 1, 20));
    expect(usageHistoryIsTrustworthy(history, opts, now)).toBe(false);
  });

  it("accepts once the history actually spans the warm-up", () => {
    // Eight unbroken days at the 6h cadence.
    const history = Array.from({ length: 32 }, (_, i) => ({
      capturedAt: new Date(Date.UTC(2026, 0, 1, i * 6)).toISOString(),
      perMember: [{ member: "m", ops: 0, since: "2026-01-01T00:00:00Z" }],
    }));
    const now = new Date(Date.UTC(2026, 0, 8, 20));
    expect(usageHistoryIsTrustworthy(history, opts, now)).toBe(true);
  });

  it("is opt-out at zero, for callers that supply their own fixtures", () => {
    const history = collects(4, 1);
    const now = new Date(Date.UTC(2026, 0, 1, 20));
    expect(usageHistoryIsTrustworthy(history, { ...opts, minHistoryDays: 0 }, now)).toBe(true);
  });
});

describe("idle databases: activity, not elapsed time", () => {
  const opts = {
    recentHours: 12,
    minHistory: 3,
    minHistoryDays: 7,
    minActiveHours: 72,
    maxGapHours: 48,
  };
  // Thirty unbroken days of collects at the 6h cadence — plenty of calendar.
  const history: UsageSnapshot[] = Array.from({ length: 120 }, (_, i) => ({
    capturedAt: new Date(Date.UTC(2026, 0, 1, i * 6)).toISOString(),
    perMember: [{ member: "m", ops: 0, since: "2025-12-01T00:00:00Z" }],
  }));
  const now = new Date(Date.UTC(2026, 0, 31));

  it("refuses a usage claim when the collection was barely queried", () => {
    // A dev cluster: up for a month, worked on for two afternoons — eighteen
    // hours of real traffic against the seventy-two the gate wants.
    expect(usageHistoryIsTrustworthy(history, opts, now, 18)).toBe(false);
  });

  it("accepts once the collection has genuinely been in use", () => {
    expect(usageHistoryIsTrustworthy(history, opts, now, 240)).toBe(true);
  });

  // Just under and just over, so the boundary is the tested thing rather than a
  // number picked far from it.
  it("draws the line at minActiveHours exactly", () => {
    expect(usageHistoryIsTrustworthy(history, opts, now, 71.9)).toBe(false);
    expect(usageHistoryIsTrustworthy(history, opts, now, 72)).toBe(true);
  });

  it("skips the check when the caller has no activity data to give", () => {
    expect(usageHistoryIsTrustworthy(history, opts, now)).toBe(true);
  });

  it("still fails on the older rules regardless of activity", () => {
    const thin = history.slice(0, 2);
    expect(usageHistoryIsTrustworthy(thin, opts, now, 500)).toBe(false);
  });
});

// The reason run-length storage needed care rather than just an ALTER TABLE.
//
// An index nobody touches now costs ONE row: the counters never move, so the
// collector extends the run it already has instead of writing another. A cluster
// nobody could reach also produces no new rows. The two have to stay
// distinguishable, because the first is the finding this engine exists to make
// and the second is the one it must refuse — and if a missing row were the only
// evidence of either, "cannot tell" would get spelled "all clear".
//
// What tells them apart is that the run is a POSITIVE statement: it says we
// looked at lastSeenAt and it was still this. An outage has no such statement to
// make, so its newest row stops moving and the hole shows up between two runs.
describe("an idle index and an unwatched index", () => {
  const opts = {
    recentHours: 12,
    minHistory: 3,
    minHistoryDays: 7,
    minActiveHours: 0,
    maxGapHours: 48,
  };
  const now = new Date(Date.UTC(2026, 1, 1));
  const member = { member: "m", ops: 0, since: "2025-01-01T00:00:00Z" };

  // Thirty days of collects at the 6h cadence that never saw the counter move:
  // one row, a hundred and twenty observations, still being confirmed.
  const idle: UsageSnapshot[] = [
    {
      capturedAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
      lastSeenAt: new Date(Date.UTC(2026, 1, 1)).toISOString(),
      observations: 120,
      perMember: [member],
    },
  ];

  it("trusts the idle one — one row, but a hundred and twenty looks", () => {
    expect(usageHistoryIsTrustworthy(idle, opts, now)).toBe(true);
  });

  it("calls the idle one FLAT_ZERO, which is what makes it droppable", () => {
    expect(classifyUsage(idle, opts)).toBe("FLAT_ZERO");
  });

  it("refuses the unwatched one, whose run stopped being extended", () => {
    // Same shape, same counters, same number of looks — but the last
    // confirmation is three weeks old, because that is when the cluster went
    // away. Nothing has said "still true" since.
    const unwatched: UsageSnapshot[] = [
      {
        capturedAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
        lastSeenAt: new Date(Date.UTC(2026, 0, 11)).toISOString(),
        observations: 120,
        perMember: [member],
      },
    ];
    expect(usageHistoryIsTrustworthy(unwatched, opts, now)).toBe(false);
  });

  it("refuses a series whose hole falls between two runs", () => {
    // Watched, lost for three weeks, watched again. Each half is a clean run and
    // the gap between them is the outage — differencing run STARTS would have
    // missed it, since the first run's own start is recent enough.
    const interrupted: UsageSnapshot[] = [
      {
        capturedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
        lastSeenAt: new Date(Date.UTC(2026, 0, 5)).toISOString(),
        observations: 16,
        perMember: [member],
      },
      {
        capturedAt: new Date(Date.UTC(2026, 0, 26)).toISOString(),
        lastSeenAt: new Date(Date.UTC(2026, 1, 1)).toISOString(),
        observations: 24,
        perMember: [{ ...member, ops: 1 }],
      },
    ];
    expect(usageHistoryIsTrustworthy(interrupted, opts, now)).toBe(false);
  });

  it("does not read the length of a quiet run as a hole", () => {
    // The inverse mistake, and the one that would have quietly disabled the
    // engine rather than endangered it: a month-long run differenced against its
    // own start looks like a month-long gap, and every idle index on every
    // cluster would have become un-judgeable.
    expect(usageHistoryIsTrustworthy(idle, { ...opts, maxGapHours: 48 }, now)).toBe(true);
  });

  it("counts looks rather than rows for minHistory", () => {
    // One row. Three collects behind it, so it clears a floor of three; two, and
    // it does not.
    const twoLooks: UsageSnapshot[] = [{ ...at(idle), observations: 2 }];
    expect(usageHistoryIsTrustworthy(twoLooks, opts, now)).toBe(false);
    expect(usageHistoryIsTrustworthy(idle, opts, now)).toBe(true);
  });
});

// #267. The gate refuses for eight different reasons and only ever said no, so
// "findings are thin on this cluster" could not be turned into "and here is the
// check doing it". The boolean is now derived from the reason, which is what
// keeps a refusal reported to metrics and a refusal acted on from diverging.
describe("usageTrustRefusal", () => {
  const opts = {
    recentHours: 12,
    minHistory: 3,
    minHistoryDays: 0,
    minActiveHours: 0,
    maxGapHours: 48,
  };
  const now = new Date("2026-03-04T00:00:00Z");
  const at = (iso: string, ops = 0, since = ""): UsageSnapshot => ({
    capturedAt: iso,
    perMember: [{ member: "m", ops, since }],
  });
  const dense = [
    at("2026-03-01T00:00:00Z"),
    at("2026-03-02T00:00:00Z"),
    at("2026-03-03T12:00:00Z"),
  ];

  it("says nothing refused when the history is trustworthy", () => {
    expect(usageTrustRefusal(dense, opts, now)).toBeNull();
  });

  it("refuses nothing for a restart on its own", () => {
    const restarted = [
      at("2026-03-01T00:00:00Z", 900, "2026-01-01T00:00:00Z"),
      at("2026-03-02T00:00:00Z", 5, "2026-02-01T00:00:00Z"),
      at("2026-03-03T12:00:00Z", 9, "2026-02-01T00:00:00Z"),
    ];
    expect(usageTrustRefusal(restarted, opts, now)).toBeNull();
  });

  it("names the warm-up when a restart is what kept the watch time short", () => {
    // The reason a restarting cluster now reports, and the difference that
    // matters: span-too-short is a number that grows, where counters-reset was
    // a state such a cluster could never leave.
    const restarted = [
      at("2026-03-01T00:00:00Z", 900, "2026-01-01T00:00:00Z"),
      at("2026-03-02T00:00:00Z", 5, "2026-02-01T00:00:00Z"),
      at("2026-03-03T12:00:00Z", 9, "2026-02-01T00:00:00Z"),
    ];
    expect(usageTrustRefusal(restarted, { ...opts, minHistoryDays: 2 }, now)).toEqual({
      kind: "span-too-short",
    });
  });

  it("names too-few-collects", () => {
    expect(usageTrustRefusal([at("2026-03-03T00:00:00Z")], opts, now)).toEqual({
      kind: "too-few-collects",
    });
  });

  it("names a hole between runs", () => {
    const holed = [
      at("2026-02-01T00:00:00Z"),
      at("2026-02-02T00:00:00Z"),
      at("2026-03-03T00:00:00Z"),
    ];
    expect(usageTrustRefusal(holed, opts, now)).toEqual({ kind: "gap-between-runs" });
  });

  it("names a hole inside a run, which the between-runs check cannot see", () => {
    const interior: UsageSnapshot[] = [
      {
        capturedAt: "2026-02-01T00:00:00Z",
        lastSeenAt: "2026-03-03T00:00:00Z",
        observations: 100,
        maxGapMs: 21 * 24 * 3_600_000,
        perMember: [{ member: "m", ops: 0, since: "" }],
      },
    ];
    expect(usageTrustRefusal(interior, opts, now)).toEqual({ kind: "gap-inside-run" });
  });

  it("names a history that stopped long ago", () => {
    const stale = [
      at("2026-01-01T00:00:00Z"),
      at("2026-01-02T00:00:00Z"),
      at("2026-01-03T00:00:00Z"),
    ];
    expect(usageTrustRefusal(stale, opts, now)).toEqual({ kind: "history-stale" });
  });

  it("names an idle collection", () => {
    expect(usageTrustRefusal(dense, { ...opts, minActiveHours: 5 }, now, 1)).toEqual({
      kind: "collection-idle",
    });
  });

  it("names a span shorter than the warm-up", () => {
    expect(usageTrustRefusal(dense, { ...opts, minHistoryDays: 30 }, now)).toEqual({
      kind: "span-too-short",
    });
  });

  // The boolean is the reason, negated. Nothing may drift between them.
  it("agrees with usageHistoryIsTrustworthy on every case above", () => {
    for (const [history, options, activeHours] of [
      [dense, opts, undefined],
      [[at("2026-03-03T00:00:00Z")], opts, undefined],
      [dense, { ...opts, minActiveHours: 5 }, 1],
    ] as const) {
      expect(usageHistoryIsTrustworthy(history, options, now, activeHours)).toBe(
        usageTrustRefusal(history, options, now, activeHours) === null,
      );
    }
  });
});
