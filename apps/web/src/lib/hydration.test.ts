import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatTimestamp, useMounted } from "./hydration";

afterEach(() => {
  vi.unstubAllGlobals();
});

// The server has no idea what timezone the reader is in, so it renders UTC and
// the browser swaps in local time after mounting. Both sides of hydration have
// to produce the same markup or React discards the tree and warns.
describe("formatTimestamp", () => {
  it("renders unambiguous UTC before mount", () => {
    expect(formatTimestamp("2026-08-02T09:30:00.000Z", false)).toBe("2026-08-02 09:30 UTC");
  });

  it("says UTC explicitly, so a reader elsewhere is not misled", () => {
    expect(formatTimestamp("2026-01-01T00:00:00.000Z", false)).toContain("UTC");
  });

  it("switches to the reader's own formatting once mounted", () => {
    const iso = "2026-08-02T09:30:00.000Z";
    const local = formatTimestamp(iso, true);
    expect(local).not.toContain("UTC");
    expect(local).toBe(new Date(iso).toLocaleString());
  });
});

describe("useMounted", () => {
  // False on the first render is the whole point — that render must match what
  // the server produced.
  it("is true after the effect runs", () => {
    const { result } = renderHook(() => useMounted());
    expect(result.current).toBe(true);
  });
});
