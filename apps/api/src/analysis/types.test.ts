import { describe, expect, it } from "vitest";
import {
  interiorGap,
  medianObservationGap,
  observationsOf,
  type Run,
  runFrom,
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

describe("interiorGap", () => {
  it("is zero for a run that has no interior to speak of", () => {
    expect(interiorGap({ capturedAt: iso(0) })).toBe(0);
    expect(interiorGap({ capturedAt: iso(0), maxGapMs: 0 })).toBe(0);
  });

  it("reports what the run recorded", () => {
    expect(interiorGap({ capturedAt: iso(0), maxGapMs: 6 * HOUR_MS })).toBe(6 * HOUR_MS);
  });

  it("treats nonsense as nothing to declare, not as a hole", () => {
    // Failing OPEN here is deliberate. A negative or NaN gap is a bug in the
    // writer, and the gate would then refuse every finding on the cluster; the
    // between-runs check still stands, so the safety floor does not move.
    expect(interiorGap({ capturedAt: iso(0), maxGapMs: -1 })).toBe(0);
    expect(interiorGap({ capturedAt: iso(0), maxGapMs: Number.NaN })).toBe(0);
  });
});

describe("runFrom", () => {
  // The point of the mapper: the fields are optional so a point reading stays a
  // one-liner, which means a DB read site can leave them out and get a silently
  // plausible answer — a year-long run collapsing to the instant it began. Going
  // through here makes that impossible to do by omission.
  it("carries every run field across, from Dates", () => {
    const run = runFrom({
      capturedAt: new Date(iso(0)),
      lastSeenAt: new Date(iso(24)),
      observations: 5,
      maxGapMs: 6 * HOUR_MS,
    });
    expect(run).toEqual({
      capturedAt: iso(0),
      lastSeenAt: iso(24),
      observations: 5,
      maxGapMs: 6 * HOUR_MS,
    });
    expect(spanEnd(run) - spanStart(run)).toBe(24 * HOUR_MS);
    expect(interiorGap(run)).toBe(6 * HOUR_MS);
  });

  it("leaves an already-serialized row alone", () => {
    expect(
      runFrom({ capturedAt: iso(0), lastSeenAt: iso(1), observations: 2, maxGapMs: 0 }),
    ).toEqual({ capturedAt: iso(0), lastSeenAt: iso(1), observations: 2, maxGapMs: 0 });
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
