import { describe, expect, it } from "vitest";
import {
  medianObservationGap,
  observationsOf,
  type Run,
  spanEnd,
  spanStart,
  totalObservations,
} from "./types";

const HOUR_MS = 3_600_000;
const iso = (hours: number): string =>
  new Date(Date.UTC(2026, 0, 1) + hours * HOUR_MS).toISOString();

describe("a point reading is a run of one", () => {
  // The defaults are what let every caller that has a single observation — a
  // test, an agent shipping one collect — build a reading without knowing runs
  // exist. They have to be exact rather than merely lenient.
  const point: Run = { capturedAt: iso(0) };

  it("ends where it starts", () => {
    expect(spanEnd(point)).toBe(spanStart(point));
  });

  it("counts as one observation", () => {
    expect(observationsOf(point)).toBe(1);
    expect(totalObservations([point, point, point])).toBe(3);
  });
});

describe("spanEnd", () => {
  it("reports the end of a run", () => {
    expect(spanEnd({ capturedAt: iso(0), lastSeenAt: iso(12) })).toBe(
      spanStart({ capturedAt: iso(12) }),
    );
  });

  it("never goes behind the start", () => {
    // A run of negative length is not a shorter run, it is a corrupt one. Clamped
    // to the point reading it must have been, so no caller has to defend against
    // a negative span.
    const backwards = { capturedAt: iso(12), lastSeenAt: iso(0) };
    expect(spanEnd(backwards)).toBe(spanStart(backwards));
  });

  it("falls back to the start on an unparseable end", () => {
    expect(spanEnd({ capturedAt: iso(0), lastSeenAt: "not a date" })).toBe(
      spanStart({ capturedAt: iso(0) }),
    );
  });
});

describe("observationsOf", () => {
  it("floors at one — a row exists because something was seen", () => {
    expect(observationsOf({ capturedAt: iso(0), observations: 0 })).toBe(1);
    expect(observationsOf({ capturedAt: iso(0), observations: -5 })).toBe(1);
    expect(observationsOf({ capturedAt: iso(0), observations: Number.NaN })).toBe(1);
  });
});

describe("medianObservationGap", () => {
  const points = (hours: readonly number[]): Run[] =>
    hours.map((hour) => ({ capturedAt: iso(hour) }));

  it("is the plain median of consecutive gaps when every row is a point", () => {
    // What it was before runs existed, and the reduction that keeps activeHours
    // returning the same numbers for a series with no collapsing in it.
    expect(medianObservationGap(points([0, 6, 12, 18]))).toBe(6 * HOUR_MS);
  });

  it("averages the two middle gaps on an even count", () => {
    // 6h, 6h, 12h, 24h -> (6 + 12) / 2.
    expect(medianObservationGap(points([0, 6, 12, 24, 48]))).toBe(9 * HOUR_MS);
  });

  it("is zero without enough readings to have a gap", () => {
    expect(medianObservationGap([])).toBe(0);
    expect(medianObservationGap(points([0]))).toBe(0);
  });

  it("weights a collapsed run by the collects inside it", () => {
    // A hundred and twenty collects six hours apart, collapsed into one row, then
    // one busy collect at the end. The cadence is six hours; without weighting,
    // the run would contribute one vote against the single transition's one and
    // the answer would land between them.
    const runs: Run[] = [
      { capturedAt: iso(0), lastSeenAt: iso(714), observations: 120 },
      { capturedAt: iso(720), lastSeenAt: iso(720) },
    ];
    expect(medianObservationGap(runs)).toBe(6 * HOUR_MS);
  });

  it("ignores a run's internal spacing when it holds a single observation", () => {
    // observations = 1 means no interval was measured inside it, whatever its
    // stamps say.
    const runs: Run[] = [
      { capturedAt: iso(0), lastSeenAt: iso(48), observations: 1 },
      { capturedAt: iso(54) },
    ];
    expect(medianObservationGap(runs)).toBe(6 * HOUR_MS);
  });
});
