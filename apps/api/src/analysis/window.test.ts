import { describe, expect, it } from "vitest";
import { inChangeWindow } from "./window";

function atHour(hour: number): Date {
  return new Date(Date.UTC(2026, 6, 30, hour, 30, 0));
}

describe("inChangeWindow", () => {
  it("is always open without a configured window", () => {
    expect(inChangeWindow(atHour(3), null, null)).toBe(true);
    expect(inChangeWindow(atHour(3), 5, null)).toBe(true);
    expect(inChangeWindow(atHour(3), null, 5)).toBe(true);
  });

  it("treats equal bounds as no window", () => {
    expect(inChangeWindow(atHour(3), 7, 7)).toBe(true);
  });

  it("handles a normal daytime window, end-exclusive", () => {
    expect(inChangeWindow(atHour(9), 9, 17)).toBe(true);
    expect(inChangeWindow(atHour(16), 9, 17)).toBe(true);
    expect(inChangeWindow(atHour(17), 9, 17)).toBe(false);
    expect(inChangeWindow(atHour(8), 9, 17)).toBe(false);
  });

  it("wraps midnight (22 -> 4)", () => {
    expect(inChangeWindow(atHour(23), 22, 4)).toBe(true);
    expect(inChangeWindow(atHour(1), 22, 4)).toBe(true);
    expect(inChangeWindow(atHour(4), 22, 4)).toBe(false);
    expect(inChangeWindow(atHour(12), 22, 4)).toBe(false);
  });
});
