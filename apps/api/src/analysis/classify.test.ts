import { describe, expect, it } from "vitest";
import { classifyUsage } from "./classify";
import type { UsageSnapshot } from "./types";

function snap(ops: number): UsageSnapshot {
  return {
    capturedAt: "2026-01-01T00:00:00Z",
    perMember: [{ member: "m", ops, since: "2026-01-01T00:00:00Z", uptimeSeconds: 100 }],
  };
}

const options = { recentWindow: 3, minHistory: 3 };

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
