import { describe, expect, it } from "vitest";
import { classifyUsage, countersRestartedDuring, usageHistoryIsTrustworthy } from "./classify";
import type { UsageSnapshot } from "./types";

// Snapshots at a given cadence, oldest first — because classifyUsage now reads
// the clock rather than counting rows, a fixture where every snapshot shares a
// timestamp cannot express "went quiet".
function series(opsPerSnapshot: readonly number[], hoursApart = 6): UsageSnapshot[] {
  return opsPerSnapshot.map((ops, i) => ({
    capturedAt: new Date(Date.UTC(2026, 0, 1, i * hoursApart)).toISOString(),
    perMember: [{ member: "m", ops, since: "2026-01-01T00:00:00Z" }],
  }));
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
  it("sums ops across replica-set members", () => {
    const split = series([0, 0, 0]).map((snapshot) => ({
      ...snapshot,
      perMember: [
        { member: "a", ops: 0, since: "" },
        { member: "b", ops: 4, since: "" },
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

describe("countersRestartedDuring", () => {
  const snap = (
    day: number,
    members: Array<{ member: string; ops: number; since?: string }>,
  ): UsageSnapshot => ({
    capturedAt: `2026-03-0${day}T00:00:00Z`,
    perMember: members,
  });
  // Counters that started well before the window.
  const OLD = "2026-01-01T00:00:00Z";

  it("is false when every counter predates the window and never moves", () => {
    const history = [
      snap(1, [{ member: "a", ops: 0, since: OLD }]),
      snap(2, [{ member: "a", ops: 0, since: OLD }]),
      snap(3, [{ member: "a", ops: 0, since: OLD }]),
    ];
    expect(countersRestartedDuring(history)).toBe(false);
  });

  it("catches a member whose counter start jumped forward", () => {
    const history = [
      snap(1, [{ member: "a", ops: 500, since: OLD }]),
      snap(2, [{ member: "a", ops: 500, since: OLD }]),
      // Restarted: counter start moves up and ops begin again at zero.
      snap(3, [{ member: "a", ops: 0, since: "2026-03-02T18:00:00Z" }]),
    ];
    expect(countersRestartedDuring(history)).toBe(true);
  });

  it("catches one restarted member among several healthy ones", () => {
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
    expect(countersRestartedDuring(history)).toBe(true);
  });

  it("catches counters younger than the window they are supposed to cover", () => {
    // Three days of snapshots, but the counter only started yesterday: it
    // cannot testify that the index was idle for those three days.
    const history = [
      snap(1, [{ member: "a", ops: 0, since: "2026-03-02T12:00:00Z" }]),
      snap(2, [{ member: "a", ops: 0, since: "2026-03-02T12:00:00Z" }]),
      snap(3, [{ member: "a", ops: 0, since: "2026-03-02T12:00:00Z" }]),
    ];
    expect(countersRestartedDuring(history)).toBe(true);
  });

  it("catches a cumulative counter that went backwards, even when since holds still", () => {
    // The SQL Server trap (#36): ALTER INDEX REBUILD zeroes the index's usage
    // row without the service restarting, so `since` — the server start —
    // never moves. Verified on 2022 CU24. A counter cannot shrink; one that
    // did restarted.
    const history = [
      snap(1, [{ member: "a", ops: 500, since: OLD }]),
      snap(2, [{ member: "a", ops: 520, since: OLD }]),
      snap(3, [{ member: "a", ops: 0, since: OLD }]),
    ];
    expect(countersRestartedDuring(history)).toBe(true);
  });

  it("catches a backwards counter on legacy rows with no since at all", () => {
    const history = [
      snap(1, [{ member: "a", ops: 300 }]),
      snap(2, [{ member: "a", ops: 40 }]),
      snap(3, [{ member: "a", ops: 45 }]),
    ];
    expect(countersRestartedDuring(history)).toBe(true);
  });

  it("does not read ordinary growth as a restart", () => {
    const history = [
      snap(1, [{ member: "a", ops: 100, since: OLD }]),
      snap(2, [{ member: "a", ops: 100, since: OLD }]),
      snap(3, [{ member: "a", ops: 260, since: OLD }]),
    ];
    expect(countersRestartedDuring(history)).toBe(false);
  });

  it("says nothing when snapshots predate the field (legacy rows)", () => {
    const history = [
      snap(1, [{ member: "a", ops: 0 }]),
      snap(2, [{ member: "a", ops: 0 }]),
      snap(3, [{ member: "a", ops: 0 }]),
    ];
    expect(countersRestartedDuring(history)).toBe(false);
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

  it("refuses once a restart lands inside it", () => {
    expect(
      usageHistoryIsTrustworthy(
        history(["2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z", "2026-03-02T06:00:00Z"]),
        opts,
        now,
      ),
    ).toBe(false);
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
    const twoLooks: UsageSnapshot[] = [{ ...idle[0], observations: 2 } as UsageSnapshot];
    expect(usageHistoryIsTrustworthy(twoLooks, opts, now)).toBe(false);
    expect(usageHistoryIsTrustworthy(idle, opts, now)).toBe(true);
  });
});
