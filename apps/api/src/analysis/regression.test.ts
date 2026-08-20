import { describe, expect, it } from "vitest";
import { evaluateRegression, latencyRatio, oldestLiveBaseline } from "./regression";

const options = { factor: 1.5, minWindowOps: 20 };

describe("evaluateRegression", () => {
  it("STABLE when too few reads happened in the window", () => {
    expect(
      evaluateRegression(
        { ops: 100, latencyMicros: 100_000 },
        { ops: 110, latencyMicros: 400_000 },
        options,
      ),
    ).toBe("STABLE");
  });

  it("REGRESSED when window average exceeds baseline x factor", () => {
    // baseline avg 1000µs; window avg (300000-100000)/100 = 2000µs > 1500
    expect(
      evaluateRegression(
        { ops: 100, latencyMicros: 100_000 },
        { ops: 200, latencyMicros: 300_000 },
        options,
      ),
    ).toBe("REGRESSED");
  });

  it("STABLE when window average is within the factor", () => {
    // window avg (250000-100000)/100 = 1500µs, not strictly > 1500
    expect(
      evaluateRegression(
        { ops: 100, latencyMicros: 100_000 },
        { ops: 200, latencyMicros: 250_000 },
        options,
      ),
    ).toBe("STABLE");
  });

  it("STABLE when there is no baseline average", () => {
    expect(
      evaluateRegression({ ops: 0, latencyMicros: 0 }, { ops: 30, latencyMicros: 90_000 }, options),
    ).toBe("STABLE");
  });

  it("UNOBSERVABLE when the ops counter fell below the baseline (mongod restarted)", () => {
    // The old code computed a NEGATIVE window here, which failed the
    // minWindowOps check and read as "no regression" — clearing the way for an
    // irreversible drop on evidence that no longer existed.
    expect(
      evaluateRegression(
        { ops: 10_000, latencyMicros: 10_000_000 },
        { ops: 42, latencyMicros: 50_000 },
        options,
      ),
    ).toBe("UNOBSERVABLE");
  });

  it("UNOBSERVABLE when only the latency counter reset", () => {
    expect(
      evaluateRegression(
        { ops: 100, latencyMicros: 900_000 },
        { ops: 5_000, latencyMicros: 10_000 },
        options,
      ),
    ).toBe("UNOBSERVABLE");
  });

  it("stays STABLE across a long but continuous gap in watching", () => {
    // Nobody was collecting for three weeks, but the server never restarted:
    // the counters kept climbing, so the observation is still valid.
    expect(
      evaluateRegression(
        { ops: 1_000, latencyMicros: 1_000_000 },
        { ops: 900_000, latencyMicros: 900_000_000 },
        options,
      ),
    ).toBe("STABLE");
  });
});

// The cumulative check's two pure halves (#282). The post-build watch takes each
// index's baseline at that index's own build time, so build #2 is measured
// against a collection already carrying #1 — three builds that each add a
// defensible 15% are three STABLE verdicts and a collection half again slower.
describe("latencyRatio", () => {
  it("is the window's average against the baseline's", () => {
    // Baseline: 1000 ops at 100µs each. Window: 1000 more at 150µs each.
    const baseline = { ops: 1000, latencyMicros: 100_000 };
    const current = { ops: 2000, latencyMicros: 250_000 };
    expect(latencyRatio(baseline, current, 20)).toBeCloseTo(1.5, 6);
  });

  it("is 1 when nothing changed", () => {
    expect(
      latencyRatio({ ops: 100, latencyMicros: 10_000 }, { ops: 200, latencyMicros: 20_000 }, 20),
    ).toBe(1);
  });

  // Null rather than 1, and the difference matters: a caller must be able to tell
  // "measured, unchanged" from "there was nothing to measure".
  it("is null when the window is too quiet to judge", () => {
    expect(
      latencyRatio({ ops: 100, latencyMicros: 10_000 }, { ops: 105, latencyMicros: 10_500 }, 20),
    ).toBeNull();
  });

  it("is null when the baseline carries no latency", () => {
    expect(
      latencyRatio({ ops: 0, latencyMicros: 0 }, { ops: 500, latencyMicros: 50_000 }, 20),
    ).toBeNull();
  });

  // The arithmetic the issue describes: three builds each adding 15% against
  // their OWN baseline land past 1.5 against the original, which is what makes
  // three STABLE verdicts and a half-again-slower collection possible.
  it("shows what three individually stable builds do together", () => {
    const original = { ops: 1000, latencyMicros: 100_000 };
    // Each build's window is 1000 ops, 15% slower than the one before it.
    let ops = original.ops;
    let micros = original.latencyMicros;
    for (const avg of [115, 132.25, 152.09]) {
      ops += 1000;
      micros += 1000 * avg;
    }
    const cumulative = latencyRatio(original, { ops, latencyMicros: micros }, 20);
    expect(cumulative).toBeGreaterThan(1.3);
    // ...and each individual step is well under the per-index gate's 1.5.
    expect(
      latencyRatio(
        { ops: 2000, latencyMicros: 215_000 },
        { ops: 3000, latencyMicros: 347_250 },
        20,
      ),
    ).toBeLessThan(1.5);
  });
});

describe("oldestLiveBaseline", () => {
  const at = (iso: string, ops: number) => ({
    builtAt: new Date(iso),
    baseline: { ops, latencyMicros: ops * 100 },
  });

  // "Before the recent run of changes", which is the whole point: the oldest
  // un-graduated build's baseline is the reading from before the run started, and
  // graduation clearing the baselines is what ends the chain.
  it("is the earliest build still carrying a baseline", () => {
    const oldest = at("2026-07-01T00:00:00.000Z", 1000);
    expect(
      oldestLiveBaseline([
        at("2026-08-01T00:00:00.000Z", 3000),
        oldest,
        at("2026-07-15T00:00:00.000Z", 2000),
      ]),
    ).toBe(oldest);
  });

  // One build on a collection has nothing cumulative to say — its own watch
  // already said it — and an empty chain is the ordinary state, not an error.
  it("is null for an empty chain", () => {
    expect(oldestLiveBaseline([])).toBeNull();
  });

  it("is the only one when there is only one", () => {
    const only = at("2026-08-01T00:00:00.000Z", 1000);
    expect(oldestLiveBaseline([only])).toBe(only);
  });
});
