import { describe, expect, it } from "vitest";
import { evaluateRegression } from "./regression";

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
