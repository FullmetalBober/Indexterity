import { describe, expect, it } from "vitest";
import { FAILURE_BASELINE_MS, utcMinute } from "../analysis";
import type { DatabaseWatch } from "../engine/ports";
import {
  hideableAt,
  memoryOf,
  rememberWatch,
  WATCH_RESUME_MS,
  waitingAgainLine,
  waitingLine,
} from "./failure-watch";

const NOW = Date.parse("2026-10-09T13:21:00Z");
const watched = (since: number): DatabaseWatch & { kind: "WATCHED" } => ({
  kind: "WATCHED",
  since: new Map([["app.orders", since]]),
  ours: true,
  confirmed: [],
  gaps: [],
  ringReachMs: null,
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

// #641. What a pass hands the engine, and what it leaves for the next one.
describe("memoryOf", () => {
  it("hands over only the nodes seen recently enough to put back", () => {
    const memory = memoryOf(
      {
        starts: { "app.orders": NOW - 5 * 3_600_000 },
        confirmed: { "a:27017": NOW - 3_600_000, "b:27017": NOW - WATCH_RESUME_MS - 60_000 },
        gaps: [{ host: "a:27017", from: NOW - 4 * 3_600_000, to: NOW - 3 * 3_600_000 }],
      },
      NOW,
    );
    expect(memory.starts).toEqual(new Map([["app.orders", NOW - 5 * 3_600_000]]));
    expect(memory.confirmed).toEqual(new Map([["a:27017", NOW - 3_600_000]]));
    expect(memory.gaps).toHaveLength(1);
  });
});

describe("rememberWatch", () => {
  const start = NOW - 10 * 3_600_000;
  const watch = {
    ...watched(start),
    confirmed: ["a:27017", "b:27017"],
    gaps: [{ host: "a:27017", from: NOW - 2 * 3_600_000, to: NOW - 3_600_000 }],
    ringReachMs: NOW - 47 * 60_000,
  };

  it("confirms the nodes it saw, and keeps a recent sighting of one it did not", () => {
    const remembered = rememberWatch(
      {
        confirmed: {
          "a:27017": NOW - 3_600_000,
          "c:27017": NOW - 3_600_000,
          "d:27017": NOW - 3 * 3_600_000,
        },
        gaps: [],
      },
      watch,
      NOW,
    );
    expect(remembered.confirmed).toEqual({
      "a:27017": NOW,
      "b:27017": NOW,
      "c:27017": NOW - 3_600_000,
    });
    expect(remembered).toMatchObject({
      starts: { "app.orders": start },
      watching: true,
      ringReachAt: new Date(NOW - 47 * 60_000),
      ringCheckedAt: new Date(NOW),
    });
  });

  // A node it saw says its own gaps, in its marker. One it did not keeps what was
  // remembered of it, for when a restart clears that marker too. A stretch over
  // before every start is in no reading.
  it("takes the gaps of the nodes it saw from them, and keeps the others'", () => {
    const remembered = rememberWatch(
      {
        confirmed: {},
        gaps: [
          { host: "a:27017", from: NOW - 9 * 3_600_000, to: NOW - 8 * 3_600_000 },
          { host: "c:27017", from: NOW - 6 * 3_600_000, to: NOW - 5 * 3_600_000 },
          { host: "c:27017", from: NOW - 12 * 3_600_000, to: NOW - 11 * 3_600_000 },
        ],
      },
      watch,
      NOW,
    );
    expect(remembered.gaps).toEqual([
      { host: "c:27017", from: NOW - 6 * 3_600_000, to: NOW - 5 * 3_600_000 },
      { host: "a:27017", from: NOW - 2 * 3_600_000, to: NOW - 3_600_000 },
    ]);
  });
});
