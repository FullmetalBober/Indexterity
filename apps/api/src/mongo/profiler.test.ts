import { describe, expect, it } from "vitest";
import {
  combineReadings,
  failedOpsReading,
  markerOf,
  type ProfilerSettings,
  planWatch,
  profilerBlindSpot,
  profilerSettings,
  ringTurnedOver,
  type SortedFailures,
  sortFailures,
  type WatchMarker,
  watchFilter,
} from "./profiler";

// A node's failures as sortFailures hands them on: none, or `n` suspect ones.
const NONE: SortedFailures = { hinted: 0, suspect: 0, suspectKinds: [], unrelated: [] };
const failing = (n: number): SortedFailures =>
  n === 0 ? NONE : { ...NONE, suspect: n, suspectKinds: [{ kind: "MaxTimeMSExpired", failed: n }] };

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
      collection: "orders",
      failures: NONE,
      sinceMs: 0,
      oldest: OLDEST,
      fill: null,
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
    expect(read({ settings: at({ was: 0 }), failures: failing(4) })).toEqual({
      kind: "WINDOW",
      ...failing(4),
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
      ...NONE,
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
    expect(read({ throughMongos: true, settings: at({ was: 0 }), failures: failing(2) })).toEqual({
      kind: "WINDOW",
      ...failing(2),
      reachMs: OLDEST.getTime(),
      blindSpot: "only app's primary shard is read, and mongos cannot say how its profiler is set",
    });
  });
});

const NOW = Date.parse("2026-10-03T12:00:00Z");
const OWNER = "cluster-1";
const wants = (entries: Record<string, string[]>) => new Map(Object.entries(entries));
// What `profile: -1` would answer once a step's filter is in place — the marker is
// all the planning reads back, and normalisation keeps it (probed on 6.0 to 9.0).
const armedWith = (marker: WatchMarker, level = 1): ProfilerSettings =>
  at({ was: level, filter: watchFilter(marker) });
const plan = (settings: ProfilerSettings, wanted: Map<string, string[]>, now = NOW) =>
  planWatch({ database: "app", owner: OWNER, settings, wanted, now });
const armed = (settings: ProfilerSettings, wanted: Map<string, string[]>): WatchMarker => {
  const step = plan(settings, wanted);
  if (step.kind !== "SET") throw new Error(`expected SET, got ${step.kind}`);
  return step.marker;
};

describe("watchFilter and markerOf", () => {
  // The marker rides in the filter as an `ns` no database can have, and comes
  // back from `profile: -1` normalised to `{ns: {$eq: …}}`.
  it("carries the marker in a clause and finds it again in the normalised form", () => {
    const marker = armed(at({ was: 0 }), wants({ "app.orders": ["a_1"] }));
    const filter = watchFilter(marker);
    expect(markerOf(filter)).toEqual(marker);
    // As `profile: -1` hands it back: the clause normalised to an explicit $eq.
    const normalised = {
      $or: [{ millis: { $gte: 100 } }, { ns: { $eq: `indexterity$${JSON.stringify(marker)}` } }],
    };
    expect(markerOf(normalised)).toEqual(marker);
    expect(markerOf({ millis: { $gte: 100 } })).toBeNull();
    expect(markerOf(undefined)).toBeNull();
  });

  // A filter replaces slowms for the slow-query log too, so the database's own
  // threshold and sample are copied in — the log is unchanged by the watch.
  it("keeps the slow-query threshold the database had", () => {
    const filter = watchFilter(armed(at({ was: 0, slowms: 250 }), wants({ "app.orders": [] })));
    expect(filter.$or[0]).toEqual({ millis: { $gte: 250 } });
    const sampled = watchFilter(
      armed(at({ was: 0, slowms: 250, sampleRate: 0.5 }), wants({ "app.orders": [] })),
    );
    expect(sampled.$or[0]).toEqual({ $and: [{ millis: { $gte: 250 } }, { $sampleRate: 0.5 }] });
  });

  // And a filter the database already had is kept as it was, regex and date and all.
  it("keeps a filter the database already had", () => {
    const theirs = {
      $and: [{ ns: { $regex: "^app\\." } }, { ts: { $gte: new Date("2026-01-01T00:00:00Z") } }],
    };
    const filter = watchFilter(armed(at({ was: 1, filter: theirs }), wants({ "app.orders": [] })));
    expect(filter.$or[0]).toEqual(theirs);
  });

  it("records failures on the watched collections only", () => {
    const filter = watchFilter(armed(at({ was: 0 }), wants({ "app.orders": [], "app.users": [] })));
    expect(filter.$or[1]).toEqual({
      ns: { $in: ["app.orders", "app.users"] },
      $or: [{ ok: 0 }, { errCode: { $exists: true } }],
    });
  });

  // Find keeps the name, an update or delete wraps it, and a pattern stays a
  // pattern — all three probed on 6.0 and 9.0.
  it("records every shape a hint at a candidate index is kept in", () => {
    const marker = armed(at({ was: 0 }), wants({ "app.orders": ["a_1"] }));
    const filter = watchFilter(marker, new Map([["app.orders\u0000a_1", { a: 1 }]]));
    expect(filter.$or[2]).toEqual({
      ns: "app.orders",
      $or: [
        { "command.hint": { $eq: "a_1" } },
        { "command.hint": { $eq: { $hint: "a_1" } } },
        { "command.hint": { $eq: { a: 1 } } },
      ],
    });
  });
});

describe("planWatch", () => {
  it("turns the profiler on where it is off, remembering that it was", () => {
    const step = plan(at({ was: 0 }), wants({ "app.orders": ["a_1"] }));
    expect(step).toEqual({
      kind: "SET",
      marker: {
        v: 1,
        owner: OWNER,
        prior: { level: 0, filter: null },
        slow: { ms: 100, rate: 1 },
        watch: { "app.orders": NOW },
        hints: { "app.orders": ["a_1"] },
      },
    });
  });

  // Level 2 records every operation already, and level 1 at slowms 0 too.
  it("leaves a profiler alone that records everything already", () => {
    expect(plan(at({ was: 2 }), wants({ "app.orders": [] }))).toEqual({ kind: "KEEP" });
    expect(plan(at({ was: 1, slowms: 0 }), wants({ "app.orders": [] }))).toEqual({ kind: "KEEP" });
  });

  it("adds to a slow-only profiler, and remembers it to put back", () => {
    const step = plan(at({ was: 1, slowms: 50 }), wants({ "app.orders": [] }));
    expect(step).toMatchObject({
      kind: "SET",
      marker: { prior: { level: 1, filter: null }, slow: { ms: 50, rate: 1 } },
    });
  });

  it("keeps a profiler that is already as wanted", () => {
    const marker = armed(at({ was: 0 }), wants({ "app.orders": ["a_1"] }));
    expect(plan(armedWith(marker), wants({ "app.orders": ["a_1"] }), NOW + 3_600_000)).toEqual({
      kind: "KEEP",
    });
  });

  // Adding a neighbour must not restart anybody's baseline.
  it("keeps each collection's start when the watched set changes", () => {
    const marker = armed(at({ was: 0 }), wants({ "app.orders": ["a_1"] }));
    const later = NOW + 3_600_000;
    const step = plan(armedWith(marker), wants({ "app.orders": [], "app.users": ["b_1"] }), later);
    expect(step).toMatchObject({
      kind: "SET",
      marker: {
        watch: { "app.orders": NOW, "app.users": later },
        hints: { "app.orders": [], "app.users": ["b_1"] },
      },
    });
  });

  // slowms is server-wide and can move under a watch; the kept clause follows it.
  it("follows a changed slowms", () => {
    const marker = armed(at({ was: 0 }), wants({ "app.orders": [] }));
    expect(
      plan(at({ was: 1, slowms: 300, filter: watchFilter(marker) }), wants({ "app.orders": [] })),
    ).toMatchObject({
      kind: "SET",
      marker: { slow: { ms: 300, rate: 1 }, watch: { "app.orders": NOW } },
    });
  });

  it("puts back exactly what was there when nothing is wanted", () => {
    const off = armed(at({ was: 0 }), wants({ "app.orders": [] }));
    expect(plan(armedWith(off), new Map())).toEqual({ kind: "RESTORE", level: 0, filter: "unset" });
    const theirs = { millis: { $gte: 20 } };
    const custom = armed(at({ was: 1, filter: theirs }), wants({ "app.orders": [] }));
    expect(plan(armedWith(custom), new Map())).toEqual({
      kind: "RESTORE",
      level: 1,
      filter: theirs,
    });
  });

  // setProfilingLevel(0) keeps the filter; a restart clears it. Level 0 with the
  // marker still there was a person, and is not overridden — but our filter still
  // goes when nothing is wanted, under the level they chose.
  it("does not fight a person who turned it off", () => {
    const marker = armed(at({ was: 0 }), wants({ "app.orders": [] }));
    expect(plan(armedWith(marker, 0), wants({ "app.orders": [] }))).toEqual({
      kind: "DECLINE",
      reason: "the profiler on app was turned off after Indexterity turned it on",
    });
    expect(plan(armedWith(marker, 0), new Map())).toEqual({
      kind: "RESTORE",
      level: 0,
      filter: "unset",
    });
    expect(plan(armedWith(marker, 2), new Map())).toEqual({
      kind: "RESTORE",
      level: 2,
      filter: "unset",
    });
  });

  it("leaves another registration's watch alone", () => {
    const theirs = planWatch({
      database: "app",
      owner: "cluster-2",
      settings: at({ was: 0 }),
      wanted: wants({ "app.orders": [] }),
      now: NOW,
    });
    if (theirs.kind !== "SET") throw new Error("expected SET");
    expect(plan(armedWith(theirs.marker), wants({ "app.orders": [] }))).toMatchObject({
      kind: "DECLINE",
    });
    expect(plan(armedWith(theirs.marker), new Map())).toEqual({ kind: "KEEP" });
  });

  it("does nothing where nothing is wanted and nothing is ours", () => {
    expect(plan(at({ was: 0 }), new Map())).toEqual({ kind: "KEEP" });
    expect(plan(at({ was: 1, filter: { millis: { $gte: 5 } } }), new Map())).toEqual({
      kind: "KEEP",
    });
  });

  // A zero threshold copied into the kept clause would profile every operation.
  it("declines rather than profile everything", () => {
    expect(plan(at({ was: 0, slowms: 0 }), wants({ "app.orders": [] }))).toMatchObject({
      kind: "DECLINE",
    });
  });
});

describe("failedOpsReading under a watch", () => {
  const marker = armed(at({ was: 0 }), wants({ "app.orders": [] }));
  const read = (overrides: Partial<Parameters<typeof failedOpsReading>[0]>) =>
    failedOpsReading({
      database: "app",
      collection: "orders",
      failures: NONE,
      sinceMs: NOW,
      oldest: null,
      fill: null,
      settings: armedWith(marker),
      throughMongos: false,
      ...overrides,
    });
  const MB = 1_048_576;
  const filled = (bytes: number) => ({ bytes, entries: 900, capBytes: MB, capEntries: null });

  // A failures-only ring is empty on a healthy database; the watch's start is
  // the reach.
  it("is a complete window from the watch's start, empty ring and all", () => {
    expect(read({})).toEqual({ kind: "WINDOW", ...NONE, reachMs: NOW, blindSpot: null });
  });

  it("takes the ring's reach once it has turned over", () => {
    const turned = new Date(NOW + 60_000);
    expect(
      read({ oldest: turned, sinceMs: NOW + 120_000, fill: filled(MB - 1_000) }),
    ).toMatchObject({
      reachMs: turned.getTime(),
      blindSpot: null,
    });
    // And where its fill cannot be read, which can only understate the reach.
    expect(read({ oldest: turned, sinceMs: NOW + 120_000 })).toMatchObject({
      reachMs: turned.getTime(),
    });
  });

  // #625: on a quiet database the first operation worth keeping can come hours
  // into the watch. The ring lost nothing, so the reach is still the watch's start.
  it("keeps the watch's start while the ring has not turned over", () => {
    const firstKept = new Date(NOW + 20 * 3_600_000);
    expect(
      read({ oldest: firstKept, sinceMs: NOW + 24 * 3_600_000, fill: filled(40_000) }),
    ).toMatchObject({ reachMs: NOW, blindSpot: null });
  });

  // Turned on after the hide — re-armed after a restart, or an index hidden before
  // the watch existed: what failed in between was not seen.
  it("says when the watch began after the instant asked about", () => {
    expect(read({ sinceMs: NOW - 3_600_000 })).toMatchObject({
      kind: "WINDOW",
      blindSpot:
        "the profiler on app has recorded failures only since 2026-10-03 12:00 UTC, after the hide",
    });
  });

  it("says a person turned it off, and still counts what it recorded", () => {
    expect(read({ settings: armedWith(marker, 0) })).toEqual({
      kind: "NO_SOURCE",
      reason: "the profiler on app was turned off after Indexterity turned it on",
    });
    expect(
      read({ settings: armedWith(marker, 0), failures: failing(4), oldest: new Date(NOW) }),
    ).toMatchObject({
      kind: "WINDOW",
      ...failing(4),
    });
  });

  // Another collection in the same database is not watched by this filter.
  it("does not vouch for a collection the watch does not cover", () => {
    expect(read({ collection: "users", oldest: new Date(NOW) })).toMatchObject({
      kind: "WINDOW",
      blindSpot: "the profiler on app keeps only what its filter selects",
    });
  });
});

describe("combineReadings", () => {
  const window = (failed: number, reachMs: number, blindSpot: string | null = null) =>
    ({ kind: "WINDOW", ...failing(failed), reachMs, blindSpot }) as const;

  it("adds failures up and takes the reach every member can vouch for", () => {
    expect(
      combineReadings([
        { host: "a:27017", reading: window(2, 100) },
        { host: "b:27017", reading: window(3, 300) },
      ]),
    ).toEqual({ kind: "WINDOW", ...failing(5), reachMs: 300, blindSpot: null });
  });

  it("says a shared caveat once, and names a member that differs", () => {
    const off = { kind: "NO_SOURCE", reason: "the profiler is off on app" } as const;
    expect(
      combineReadings([
        { host: "a:27017", reading: off },
        { host: "b:27017", reading: off },
      ]),
    ).toEqual(off);
    expect(
      combineReadings([
        { host: "a:27017", reading: window(0, 100) },
        { host: "b:27017", reading: off },
      ]),
    ).toEqual({
      kind: "WINDOW",
      ...failing(0),
      reachMs: 100,
      blindSpot: "on b:27017, the profiler is off on app",
    });
  });

  it("is the one member's reading when there is one", () => {
    expect(combineReadings([{ host: "a:27017", reading: window(1, 5) }])).toEqual(window(1, 5));
  });
});

describe("combineReadings, sorted", () => {
  it("adds every class up across members, kinds merged", () => {
    const member = (failures: SortedFailures) =>
      ({ kind: "WINDOW", ...failures, reachMs: 0, blindSpot: null }) as const;
    expect(
      combineReadings([
        {
          host: "a:27017",
          reading: member({
            ...failing(2),
            hinted: 1,
            unrelated: [{ kind: "DuplicateKey", failed: 1 }],
          }),
        },
        {
          host: "b:27017",
          reading: member({ ...failing(1), unrelated: [{ kind: "DuplicateKey", failed: 2 }] }),
        },
      ]),
    ).toMatchObject({
      hinted: 1,
      suspect: 3,
      suspectKinds: [{ kind: "MaxTimeMSExpired", failed: 3 }],
      unrelated: [{ kind: "DuplicateKey", failed: 3 }],
    });
  });
});

// #625. What the profiler kept, grouped on the server by error and hint, sorted
// by what could have caused it. Every shape here was recorded by mongod 6.0.28,
// 7.0.39, 8.2.9 and 9.0.2 with the index hidden.
describe("sortFailures", () => {
  const INDEX = { name: "cycle.id_1", key: { "cycle.id": 1 } };
  const bad = (hint: string | Record<string, unknown> | null, failed = 1) => ({
    code: 2,
    name: "BadValue",
    hint,
    failed,
  });

  // A find or an aggregate keeps the name, an update or a delete keeps it
  // wrapped, and a key-pattern hint stays the pattern.
  it("counts a failed hint at the index in every shape the profiler keeps", () => {
    expect(
      sortFailures(
        [bad("cycle.id_1", 2), bad({ $hint: "cycle.id_1" }), bad({ "cycle.id": 1 })],
        INDEX,
      ),
    ).toEqual({ hinted: 4, suspect: 0, suspectKinds: [], unrelated: [] });
  });

  // A hint at an index that never existed fails with the same BadValue, so a hint
  // failure is the hide's doing only when it names THIS index.
  it("does not count a failed hint at another index, or a pattern that is not this one", () => {
    expect(
      sortFailures(
        [
          bad("cycle.id_1"),
          bad({ $hint: "date_1" }),
          // A prefix of the pattern, its direction turned, its order changed.
          bad({ "cycle.id": 1 }),
          bad({ "cycle.id": 1, date: -1 }),
          bad({ date: 1, "cycle.id": 1 }),
          // And the pattern itself.
          bad({ "cycle.id": 1, date: 1 }),
        ],
        { name: "cycle.id_1_date_1", key: { "cycle.id": 1, date: 1 } },
      ),
    ).toMatchObject({ hinted: 1, unrelated: [{ kind: "BadValue", failed: 5 }] });
  });

  // Unknown takes the side that keeps the index.
  it("counts a pattern hint as the index's when its key could not be read", () => {
    expect(sortFailures([bad({ anything: 1 })], { name: "cycle.id_1", key: null })).toMatchObject({
      hinted: 1,
    });
  });

  it("calls a timeout, a sort over its limit and a missing plan suspect", () => {
    expect(
      sortFailures(
        [
          { code: 50, name: "MaxTimeMSExpired", hint: null, failed: 2 },
          { code: 292, name: "QueryExceededMemoryLimitNoDiskUseAllowed", hint: null, failed: 1 },
          { code: 291, name: "NoQueryExecutionPlans", hint: null, failed: 1 },
          { code: 27, name: "IndexNotFound", hint: null, failed: 1 },
        ],
        INDEX,
      ),
    ).toEqual({
      hinted: 0,
      suspect: 5,
      suspectKinds: [
        { kind: "MaxTimeMSExpired", failed: 2 },
        { kind: "IndexNotFound", failed: 1 },
        { kind: "NoQueryExecutionPlans", failed: 1 },
        { kind: "QueryExceededMemoryLimitNoDiskUseAllowed", failed: 1 },
      ],
      unrelated: [],
    });
  });

  // The application's own: none of these is a missing index's doing.
  it("counts nothing else, and keeps it by kind", () => {
    expect(
      sortFailures(
        [
          { code: 11000, name: "DuplicateKey", hint: null, failed: 2 },
          { code: 121, name: "DocumentValidationFailure", hint: null, failed: 1 },
          { code: 2, name: "BadValue", hint: null, failed: 1 },
          { code: 279, name: "ClientDisconnect", hint: null, failed: 1 },
          { code: 999, name: null, hint: null, failed: 1 },
          { code: null, name: null, hint: null, failed: 1 },
        ],
        INDEX,
      ),
    ).toEqual({
      hinted: 0,
      suspect: 0,
      suspectKinds: [],
      unrelated: [
        { kind: "DuplicateKey", failed: 2 },
        { kind: "BadValue", failed: 1 },
        { kind: "ClientDisconnect", failed: 1 },
        { kind: "DocumentValidationFailure", failed: 1 },
        { kind: "error 999", failed: 1 },
        { kind: "unnamed errors", failed: 1 },
      ],
    });
  });

  it("names a suspect kind the profiler did not name", () => {
    expect(
      sortFailures([{ code: 50, name: null, hint: null, failed: 1 }], INDEX).suspectKinds,
    ).toEqual([{ kind: "MaxTimeMSExpired", failed: 1 }]);
  });
});

// #625. Probed on 6.0.28 and 9.0.2: a 1 MB ring held 910,751 bytes at a thousand
// entries before it turned over, and stayed within one entry of its cap after.
describe("ringTurnedOver", () => {
  const MB = 1_048_576;
  const fill = (bytes: number, entries = 1_000, capEntries: number | null = null) => ({
    bytes,
    entries,
    capBytes: MB,
    capEntries,
  });

  it("says a ring within a tenth of its cap has turned over", () => {
    expect(ringTurnedOver(fill(1_048_430))).toBe(true);
    expect(ringTurnedOver(fill(1_046_791))).toBe(true);
    expect(ringTurnedOver(fill(MB * 0.9))).toBe(true);
  });

  it("says a ring further from its cap has not", () => {
    expect(ringTurnedOver(fill(910_751 - 50_000))).toBe(false);
    expect(ringTurnedOver(fill(0, 0))).toBe(false);
  });

  // A ring created with `max` turns over on its entry count as well.
  it("counts entries against an entry cap", () => {
    expect(ringTurnedOver(fill(10_000, 995, 1_000))).toBe(true);
    expect(ringTurnedOver(fill(10_000, 100, 1_000))).toBe(false);
  });

  it("does not know when the fill could not be read", () => {
    expect(ringTurnedOver(null)).toBeNull();
    expect(ringTurnedOver({ bytes: 0, entries: 0, capBytes: 0, capEntries: null })).toBeNull();
  });
});
