import { describe, expect, it } from "vitest";
import { DEFAULT_STORAGE_USD_PER_GB_MONTH, monthlySavingsUsd } from "./cost";

describe("monthlySavingsUsd", () => {
  it("prices freed bytes at the default rate", () => {
    expect(monthlySavingsUsd(1024 ** 3)).toBeCloseTo(0.25, 6);
  });
  it("scales with a custom rate", () => {
    expect(monthlySavingsUsd(2 * 1024 ** 3, 0.5)).toBeCloseTo(1.0, 6);
  });
  it("is zero for zero/negative bytes or rate", () => {
    expect(monthlySavingsUsd(0)).toBe(0);
    expect(monthlySavingsUsd(-5)).toBe(0);
    expect(monthlySavingsUsd(1024 ** 3, 0)).toBe(0);
  });
  it("exposes a positive default rate", () => {
    expect(DEFAULT_STORAGE_USD_PER_GB_MONTH).toBeGreaterThan(0);
  });
});
