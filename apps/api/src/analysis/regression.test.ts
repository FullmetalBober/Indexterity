import { describe, expect, it } from "vitest";
import { isRegression } from "./regression";

const options = { factor: 1.5, minWindowOps: 20 };

describe("isRegression", () => {
  it("false when too few reads happened in the window", () => {
    expect(
      isRegression({ ops: 100, latencyMicros: 100_000 }, { ops: 110, latencyMicros: 400_000 }, options),
    ).toBe(false);
  });
  it("true when window average exceeds baseline x factor", () => {
    // baseline avg 1000µs; window avg (300000-100000)/100 = 2000µs > 1500
    expect(
      isRegression({ ops: 100, latencyMicros: 100_000 }, { ops: 200, latencyMicros: 300_000 }, options),
    ).toBe(true);
  });
  it("false when window average is within the factor", () => {
    // window avg (250000-100000)/100 = 1500µs, not strictly > 1500
    expect(
      isRegression({ ops: 100, latencyMicros: 100_000 }, { ops: 200, latencyMicros: 250_000 }, options),
    ).toBe(false);
  });
  it("false when there is no baseline average", () => {
    expect(
      isRegression({ ops: 0, latencyMicros: 0 }, { ops: 30, latencyMicros: 90_000 }, options),
    ).toBe(false);
  });
});
