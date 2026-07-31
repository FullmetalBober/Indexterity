import { describe, expect, it } from "vitest";
import { dynamicObserveDays } from "./observe";

function point(day: number, ops: number): { capturedAt: string; ops: number } {
  return { capturedAt: new Date(Date.UTC(2026, 0, 1 + day)).toISOString(), ops };
}

describe("dynamicObserveDays", () => {
  it("keeps the policy window when history is unremarkable", () => {
    const history = [point(0, 5), point(1, 3), point(2, 8)];
    expect(dynamicObserveDays(history, 30)).toEqual({ days: 30, reason: null });
  });

  it("extends to 2× the largest activity gap for periodic usage", () => {
    // Active on day 0, 20, 40 — a ~20-day cadence; 30 days could miss a cycle.
    const history = [point(0, 5), point(10, 0), point(20, 5), point(30, 0), point(40, 5)];
    const window = dynamicObserveDays(history, 30);
    expect(window.days).toBe(40);
    expect(window.reason).toContain("periodic usage");
  });

  it("caps the extension at 90 days", () => {
    const history = [point(0, 5), point(80, 5)];
    expect(dynamicObserveDays(history, 30).days).toBe(90);
  });

  it("never extends below the policy (small gaps change nothing)", () => {
    const history = [point(0, 5), point(2, 5), point(4, 5)];
    expect(dynamicObserveDays(history, 30)).toEqual({ days: 30, reason: null });
  });

  it("shortens for an index proven idle across 2× the policy window", () => {
    const history = [point(0, 0), point(30, 0), point(65, 0)];
    const window = dynamicObserveDays(history, 30);
    expect(window.days).toBe(15);
    expect(window.reason).toContain("zero usage across");
  });

  it("never shortens below a week, and never below a tighter policy", () => {
    const idle = [point(0, 0), point(100, 0)];
    expect(dynamicObserveDays(idle, 10).days).toBe(7);
    // A 5-day policy is already under the floor — unchanged.
    expect(dynamicObserveDays(idle, 5)).toEqual({ days: 5, reason: null });
  });

  it("does not shorten on thin history", () => {
    expect(dynamicObserveDays([point(0, 0)], 30)).toEqual({ days: 30, reason: null });
    expect(dynamicObserveDays([], 30)).toEqual({ days: 30, reason: null });
  });
});
