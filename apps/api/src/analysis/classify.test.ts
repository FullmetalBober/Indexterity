import { describe, expect, it } from "vitest";
import { classifyUsage, usageHistoryIsTrustworthy } from "./classify";
import type { UsageSnapshot } from "./types";

function snap(ops: number): UsageSnapshot {
  return {
    capturedAt: "2026-01-01T00:00:00Z",
    perMember: [{ member: "m", ops, since: "2026-01-01T00:00:00Z", uptimeSeconds: 100 }],
  };
}

const options = { recentWindow: 3, minHistory: 3, maxGapHours: 48 };

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
        { member: "a", ops: 0, since: "", uptimeSeconds: 100 },
        { member: "b", ops: 4, since: "", uptimeSeconds: 100 },
      ],
    };
    expect(classifyUsage([split, split, split], options)).toBe("CONTINUOUS");
  });
});

describe("usageHistoryIsTrustworthy", () => {
  const opts = { recentWindow: 3, minHistory: 3, maxGapHours: 48 };
  const at = (iso: string, ops = 0): UsageSnapshot => ({
    capturedAt: iso,
    perMember: [{ member: "m", ops, since: "", uptimeSeconds: 100 }],
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
