import type { IndexSizePoint } from "@repo/contracts";
import { describe, expect, it } from "vitest";
import { summarizeFootprint } from "./footprint";

function point(day: string, totalBytes: number | null, indexCount = 3): IndexSizePoint {
  return { day: `2026-08-${day}T00:00:00.000Z`, totalBytes, indexCount };
}

describe("summarizeFootprint", () => {
  it("reports the change between the first and last day collected", () => {
    expect(summarizeFootprint([point("01", 4096), point("02", 3072), point("03", 2048)])).toEqual({
      firstBytes: 4096,
      latestBytes: 2048,
      changeBytes: -2048,
    });
  });

  // Negative is the good direction and positive is the point of the panel: the
  // ROI headline cannot report growth, because it only counts what was removed.
  it("reports growth as growth", () => {
    expect(summarizeFootprint([point("01", 1024), point("02", 9216)]).changeBytes).toBe(8192);
  });

  // The bug this function exists to make impossible. A cluster nobody has
  // collected since Tuesday ends the series in nulls, and reading the last
  // element as its footprint would say it shed every index it had.
  it("ignores the gap days at either end", () => {
    const summary = summarizeFootprint([
      point("01", null, 0),
      point("02", 8192),
      point("03", 6144),
      point("04", null, 0),
      point("05", null, 0),
    ]);
    expect(summary).toEqual({ firstBytes: 8192, latestBytes: 6144, changeBytes: -2048 });
  });

  it("reads across a hole in the middle rather than restarting at it", () => {
    const summary = summarizeFootprint([
      point("01", 8192),
      point("02", null, 0),
      point("03", 4096),
    ]);
    expect(summary.changeBytes).toBe(-4096);
  });

  // One day is a measurement. Reporting 0 would say "no change" about a cluster
  // that has been looked at exactly once.
  it("has no change to report from a single collected day", () => {
    expect(summarizeFootprint([point("01", null, 0), point("02", 5120)])).toEqual({
      firstBytes: 5120,
      latestBytes: 5120,
      changeBytes: null,
    });
  });

  it("answers with nothing for a cluster that has never been collected", () => {
    expect(summarizeFootprint([point("01", null, 0), point("02", null, 0)])).toEqual({
      firstBytes: null,
      latestBytes: null,
      changeBytes: null,
    });
    expect(summarizeFootprint([])).toEqual({
      firstBytes: null,
      latestBytes: null,
      changeBytes: null,
    });
  });

  // A footprint that genuinely held steady says so — this is the one case where
  // zero is an answer rather than a missing one, and it must not collapse to
  // null the way "not enough days" does.
  it("distinguishes a steady footprint from an unknown one", () => {
    expect(summarizeFootprint([point("01", 4096), point("02", 4096)]).changeBytes).toBe(0);
  });
});
