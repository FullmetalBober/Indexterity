import { describe, expect, it } from "vitest";
import { CostUtils, DEFAULT_STORAGE_USD_PER_GB_MONTH } from "./cost.utils";

// Constructed, not booted. Every provider in this directory is a function of its
// arguments, so its tests stay what they were — fixtures in, verdict out — and a
// TestingModule here would be testing the container instead of the arithmetic.
const cost = new CostUtils();

describe("monthlySavingsUsd", () => {
  it("prices freed bytes at the default rate", () => {
    expect(cost.monthlySavingsUsd(1024 ** 3)).toBeCloseTo(0.25, 6);
  });
  it("scales with a custom rate", () => {
    expect(cost.monthlySavingsUsd(2 * 1024 ** 3, 0.5)).toBeCloseTo(1.0, 6);
  });
  it("is zero for zero/negative bytes or rate", () => {
    expect(cost.monthlySavingsUsd(0)).toBe(0);
    expect(cost.monthlySavingsUsd(-5)).toBe(0);
    expect(cost.monthlySavingsUsd(1024 ** 3, 0)).toBe(0);
  });
  it("exposes a positive default rate", () => {
    expect(DEFAULT_STORAGE_USD_PER_GB_MONTH).toBeGreaterThan(0);
  });
});
