import { describe, expect, it } from "vitest";
import { FAILURE_BASELINE_MS, utcMinute } from "../analysis";
import type { DatabaseWatch } from "../engine/ports";
import { hideableAt, waitingAgainLine, waitingLine } from "./failure-watch";

const NOW = Date.parse("2026-10-09T13:21:00Z");
const watched = (since: number): DatabaseWatch => ({
  kind: "WATCHED",
  since: new Map([["app.orders", since]]),
  ours: true,
});

describe("hideableAt", () => {
  it("is a day after the namespace's watch began", () => {
    expect(hideableAt(watched(NOW), "app.orders")).toBe(NOW + FAILURE_BASELINE_MS);
  });

  // A profiler that records everything already has nothing to wait out.
  it("is at once where the watch starts at zero", () => {
    expect(hideableAt(watched(0), "app.orders")).toBe(FAILURE_BASELINE_MS);
    expect(hideableAt(watched(NOW), "app.users")).toBe(FAILURE_BASELINE_MS);
  });

  it("asks nothing where there is no watch of ours", () => {
    expect(hideableAt(undefined, "app.orders")).toBeNull();
    expect(
      hideableAt({ kind: "UNWATCHED", reason: "the profiler is off", ours: false }, "app.orders"),
    ).toBeNull();
  });
});

// #630: a restart clears the profiler's settings and the watch starts over, which
// costs a waiting drop a day. Said in its trail, where it used to be silent.
describe("waitingAgainLine", () => {
  it("says the record started over, why that happens, and until when the drop waits", () => {
    const line = waitingAgainLine("app", "orders", NOW);
    expect(line).toBe(
      `waiting again: the record of failed operations on app.orders started over at ${utcMinute(NOW)}, ` +
        "as it does when a server restarts and its profiler loses Indexterity's settings, so the " +
        `hide waits until ${utcMinute(NOW + FAILURE_BASELINE_MS)} for a day to compare against`,
    );
    // Both lines name the instant the drop waits for, which is how a pass knows
    // the trail has said it already.
    expect(waitingLine("app", "orders", NOW)).toContain(
      `until ${utcMinute(NOW + FAILURE_BASELINE_MS)}`,
    );
  });
});
