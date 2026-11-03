import { describe, expect, it } from "vitest";
import { OWN_OUTAGE_MS, outagesBetween, ownOutageMs, spansOwnOutage } from "./own-outage";

const HOUR = 3_600_000;
const T = Date.UTC(2026, 9, 31, 14);

// #653. The ledger's stretches, and the gaps between them that are ours.
describe("outagesBetween", () => {
  it("is the gap between two stretches wider than a missed tick", () => {
    const outages = outagesBetween([
      { sinceMs: T + 69 * HOUR, lastSeenMs: T + 80 * HOUR },
      { sinceMs: T - 48 * HOUR, lastSeenMs: T },
    ]);
    expect(outages).toEqual([{ fromMs: T, toMs: T + 69 * HOUR }]);
  });

  it("is nothing for a gap a late tick explains", () => {
    expect(
      outagesBetween([
        { sinceMs: T - HOUR, lastSeenMs: T },
        { sinceMs: T + OWN_OUTAGE_MS, lastSeenMs: T + OWN_OUTAGE_MS + HOUR },
      ]),
    ).toEqual([]);
    expect(outagesBetween([])).toEqual([]);
  });
});

describe("spansOwnOutage and ownOutageMs", () => {
  const outages = [{ fromMs: T, toMs: T + 69 * HOUR }];

  it("says whether a window touches an outage of ours", () => {
    expect(spansOwnOutage(outages, T - HOUR, T + HOUR)).toBe(true);
    expect(spansOwnOutage(outages, T - 2 * HOUR, T)).toBe(false);
    expect(spansOwnOutage(outages, T + 69 * HOUR, T + 70 * HOUR)).toBe(false);
  });

  it("charges only the part inside the span asked about", () => {
    expect(ownOutageMs(outages, T - 10 * HOUR, T + 100 * HOUR)).toBe(69 * HOUR);
    expect(ownOutageMs(outages, T + 60 * HOUR, T + 100 * HOUR)).toBe(9 * HOUR);
    expect(ownOutageMs(outages, T + 70 * HOUR, T + 100 * HOUR)).toBe(0);
  });
});
