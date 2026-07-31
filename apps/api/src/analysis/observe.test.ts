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

// Day 0 is 2026-01-01; `at(day)` is a clock reading, `since(day)` the moment
// collection for the cluster began.
function at(day: number): Date {
  return new Date(Date.UTC(2026, 0, 1 + day));
}
function since(day: number): string {
  return at(day).toISOString();
}

describe("dynamicObserveDays — age", () => {
  it("shortens for an index created on our watch and never used", () => {
    // Watching from day 0; the index first appears on day 10 and is idle.
    const history = [point(10, 0), point(11, 0), point(12, 0)];
    const window = dynamicObserveDays(history, 30, { watchingSince: since(0), now: at(22) });
    expect(window.days).toBe(12);
    expect(window.reason).toContain("created 12 days ago");
  });

  it("floors that shortening at a week", () => {
    const history = [point(10, 0), point(11, 0)];
    const window = dynamicObserveDays(history, 30, { watchingSince: since(0), now: at(12) });
    expect(window.days).toBe(7);
  });

  it("will not call an index young just because we onboarded recently", () => {
    // The index is in the very first snapshot, so it predates our watching and
    // could be years old. No tenure claim, no shortening.
    const history = [point(0, 0), point(1, 0), point(2, 0)];
    expect(dynamicObserveDays(history, 30, { watchingSince: since(0), now: at(3) })).toEqual({
      days: 30,
      reason: null,
    });
  });

  it("makes no age claim without a watching-since", () => {
    const history = [point(10, 0), point(11, 0)];
    expect(dynamicObserveDays(history, 30, { watchingSince: null, now: at(12) })).toEqual({
      days: 30,
      reason: null,
    });
  });

  it("extends for a long-standing index that saw real use", () => {
    // Appeared on day 5, used early, quiet since, and now 90 days old.
    const history = [point(5, 12), point(20, 0), point(60, 0)];
    const window = dynamicObserveDays(history, 30, { watchingSince: since(0), now: at(95) });
    expect(window.days).toBe(45);
    expect(window.reason).toContain("in place 90 days");
  });

  it("prefers the periodic cadence over the veteran extension", () => {
    // Both rules match; the measured cadence is the more specific answer.
    const history = [point(5, 5), point(45, 5), point(85, 5)];
    const window = dynamicObserveDays(history, 30, { watchingSince: since(0), now: at(95) });
    expect(window.days).toBe(80);
    expect(window.reason).toContain("periodic usage");
  });

  it("prefers long-proven idleness over the age rule", () => {
    // 65 days of watched silence is stronger evidence than the index's age.
    const history = [point(5, 0), point(35, 0), point(70, 0)];
    const window = dynamicObserveDays(history, 30, { watchingSince: since(0), now: at(75) });
    expect(window.days).toBe(15);
    expect(window.reason).toContain("zero usage across");
  });
});
