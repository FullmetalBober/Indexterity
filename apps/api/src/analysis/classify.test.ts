import { describe, expect, it } from "vitest";
import { classifyUsage, countersRestartedDuring, usageHistoryIsTrustworthy } from "./classify";
import type { UsageSnapshot } from "./types";

function snap(ops: number): UsageSnapshot {
  return {
    capturedAt: "2026-01-01T00:00:00Z",
    perMember: [{ member: "m", ops, since: "2026-01-01T00:00:00Z" }],
  };
}

const options = { recentWindow: 3, minHistory: 3, minHistoryDays: 0, maxGapHours: 48 };

describe("classifyUsage", () => {
  it("FLAT_ZERO below minHistory", () => {
    expect(classifyUsage([snap(5), snap(5)], options)).toBe("FLAT_ZERO");
  });
  it("FLAT_ZERO when every snapshot is idle", () => {
    expect(classifyUsage([snap(0), snap(0), snap(0)], options)).toBe("FLAT_ZERO");
  });
  it("CONTINUOUS when every snapshot is active", () => {
    expect(classifyUsage([snap(1), snap(2), snap(3)], options)).toBe("CONTINUOUS");
  });
  it("PERIODIC_ALIVE when the recent window still fires", () => {
    expect(classifyUsage([snap(5), snap(0), snap(0), snap(3)], options)).toBe("PERIODIC_ALIVE");
  });
  it("PERIODIC_DEAD when it fired once then went quiet", () => {
    expect(classifyUsage([snap(5), snap(0), snap(0), snap(0)], options)).toBe("PERIODIC_DEAD");
  });
  it("sums ops across replica-set members", () => {
    const split: UsageSnapshot = {
      capturedAt: "2026-01-01T00:00:00Z",
      perMember: [
        { member: "a", ops: 0, since: "" },
        { member: "b", ops: 4, since: "" },
      ],
    };
    expect(classifyUsage([split, split, split], options)).toBe("CONTINUOUS");
  });
});

describe("usageHistoryIsTrustworthy", () => {
  const opts = { recentWindow: 3, minHistory: 3, minHistoryDays: 0, maxGapHours: 48 };
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
  const opts = { recentWindow: 3, minHistory: 3, minHistoryDays: 0, maxGapHours: 48 };
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
  const opts = { recentWindow: 3, minHistory: 3, minHistoryDays: 7, maxGapHours: 48 };
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
