import { describe, expect, it } from "vitest";
import {
  failedOpsReading,
  type ProfilerSettings,
  profilerBlindSpot,
  profilerSettings,
} from "./profiler";

const at = (settings: Partial<ProfilerSettings>): ProfilerSettings => ({
  was: 1,
  slowms: 100,
  sampleRate: 1,
  ...settings,
});

describe("profilerBlindSpot", () => {
  // Level 2 records every operation and overrides slowms and sampleRate alike.
  it("has none at level 2", () => {
    expect(profilerBlindSpot("app", at({ was: 2 }))).toBeNull();
    expect(profilerBlindSpot("app", at({ was: 2, sampleRate: 0.1 }))).toBeNull();
  });

  // The case that read as clean before #596: on mongod 6.0 to 9.0 a hint at a
  // hidden index fails in 0 ms, and this profiler recorded nothing of it.
  it("names slowms at level 1 with no filter, because a failure is fast", () => {
    expect(profilerBlindSpot("app", at({}))).toBe(
      "the profiler on app keeps only operations slower than 100 ms, and a failed one is fast",
    );
  });

  it("says when slow operations are only sampled", () => {
    expect(profilerBlindSpot("app", at({ sampleRate: 0.25 }))).toContain(
      "a 25% sample of operations slower than 100 ms",
    );
  });

  // slowms 0 keeps everything, sampled at sampleRate.
  it("has none at level 1 with slowms 0 and no sampling", () => {
    expect(profilerBlindSpot("app", at({ slowms: 0 }))).toBeNull();
    expect(profilerBlindSpot("app", at({ slowms: 0, sampleRate: 0.5 }))).not.toBeNull();
  });

  // A filter replaces slowms outright, and what it keeps is the customer's to say.
  it("defers to a filter it did not write", () => {
    expect(profilerBlindSpot("app", at({ filter: { millis: { $gte: 50 } } }))).toBe(
      "the profiler on app keeps only what its filter selects",
    );
  });

  // Off now, with failures still in the ring from when it was on.
  it("says the profiler has since been turned off", () => {
    expect(profilerBlindSpot("app", at({ was: 0 }))).toBe(
      "the profiler on app has since been turned off",
    );
  });

  it("does not assume a complete source when the settings are unreadable", () => {
    expect(profilerBlindSpot("app", null)).toContain("could not be read");
  });
});

describe("profilerSettings", () => {
  // What mongod 9.0 answered `profile: -1`, verbatim but for the Long: newer
  // servers add fields, and the parse must not care.
  it("parses a real answer and ignores fields it does not use", () => {
    expect(
      profilerSettings.parse({
        was: 1,
        slowms: 100,
        slowinprogms: 5000,
        sampleRate: 1,
        filter: { ok: { $eq: 0 } },
        note: "When a filter expression is set, slowms and sampleRate are not used for profiling and slow-query log lines.",
        ok: 1,
      }),
    ).toEqual({ was: 1, slowms: 100, sampleRate: 1, filter: { ok: { $eq: 0 } } });
  });
});

describe("failedOpsReading", () => {
  const OLDEST = new Date("2026-10-01T00:00:00Z");
  const read = (overrides: Partial<Parameters<typeof failedOpsReading>[0]>) =>
    failedOpsReading({
      database: "app",
      failed: 0,
      oldest: OLDEST,
      settings: at({ was: 2 }),
      throughMongos: false,
      ...overrides,
    });

  // The production line that prompted #596: profiler off, nothing in the ring.
  it("names a profiler that is off", () => {
    expect(read({ settings: at({ was: 0 }), oldest: null })).toEqual({
      kind: "NO_SOURCE",
      reason: "the profiler is off on app",
    });
    // Off, with history from when it was on that shows nothing failing: still no
    // source, because nothing records failures now.
    expect(read({ settings: at({ was: 0 }) })).toEqual({
      kind: "NO_SOURCE",
      reason: "the profiler is off on app",
    });
  });

  // One-way: failures recorded before somebody turned the profiler off are still
  // failures.
  it("still counts failures a profiler recorded before it was turned off", () => {
    expect(read({ settings: at({ was: 0 }), failed: 4 })).toEqual({
      kind: "WINDOW",
      failed: 4,
      reachMs: OLDEST.getTime(),
      blindSpot: "the profiler on app has since been turned off",
    });
  });

  it("names a profiler that is on and has recorded nothing", () => {
    expect(read({ settings: at({}), oldest: null })).toEqual({
      kind: "NO_SOURCE",
      reason: "the profiler on app has recorded nothing yet",
    });
  });

  // The reach is the whole ring's, so a collection with nothing in it is a window.
  it("reads a complete source as a window with no blind spot", () => {
    expect(read({})).toEqual({
      kind: "WINDOW",
      failed: 0,
      reachMs: OLDEST.getTime(),
      blindSpot: null,
    });
  });

  it("carries a slow-only profiler's blind spot", () => {
    expect(read({ settings: at({}) })).toMatchObject({
      kind: "WINDOW",
      blindSpot:
        "the profiler on app keeps only operations slower than 100 ms, and a failed one is fast",
    });
  });

  // Through mongos the read reaches the primary shard's ring, but `profile: -1`
  // answers for mongos, which always says level 0 — probed with the shard at 2.
  it("never calls the profiler off through mongos", () => {
    expect(read({ throughMongos: true, settings: at({ was: 0 }), oldest: null })).toEqual({
      kind: "NO_SOURCE",
      reason:
        "app's primary shard has profiled nothing, and mongos cannot say whether its profiler is on",
    });
    expect(read({ throughMongos: true, settings: at({ was: 0 }), failed: 2 })).toEqual({
      kind: "WINDOW",
      failed: 2,
      reachMs: OLDEST.getTime(),
      blindSpot: "only app's primary shard is read, and mongos cannot say how its profiler is set",
    });
  });
});
