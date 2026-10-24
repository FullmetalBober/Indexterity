import { BSON, type Document } from "mongodb";
import { z } from "zod";
import { mergeTallies, span, utcMinute } from "../analysis/failures";
import type { FailedOpsReading, FailedOpsWindow } from "../engine/ports";
import { isRecord } from "../errors/message";
import type { MongoConnection } from "./connection";

// What `profile: -1` answers for one database. The level and the filter are the
// database's own; `slowms` and `sampleRate` are server-wide and only reported
// here (probed on mongod 6.0 to 9.0: a filter set on one database leaves another
// at `was: 0` with none).
export const profilerSettings = z.object({
  was: z.coerce.number(),
  slowms: z.coerce.number(),
  sampleRate: z.coerce.number().optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
});
export type ProfilerSettings = z.infer<typeof profilerSettings>;

// The profiler's settings on one database on one node, or null when they cannot
// be read. `profile: -1` needs no privilege the engine role lacks — probed with
// the role on mongod 6.0 to 9.0; only SETTING the level needs `enableProfiler`.
export async function profilerSettingsOn(
  conn: MongoConnection,
  database: string,
): Promise<ProfilerSettings | null> {
  try {
    return profilerSettings.parse(await conn.db(database).command({ profile: -1 }));
  } catch {
    return null;
  }
}

// What a profiler set up like this does NOT record, as a clause the audit line
// can carry after "but" — or null when it records every operation.
//
// Read off the settings because the ring alone cannot tell. Every case below was
// measured on mongod 6.0 to 9.0 with a hint at a hidden index, which fails in
// 0 ms:
//   - level 2 records it, and overrides sampleRate as well as slowms: 50 of 50
//     failures kept at a sampleRate of 0.01.
//   - level 1 with no filter records operations slower than `slowms`, so not it —
//     unless slowms is 0, where 10 of 10 were kept.
//   - level 1 with a filter records what the filter selects, and replaces
//     `slowms` outright — what that filter keeps is the customer's to say.
//   - level 0 records nothing new; only what is still in the ring from before.
export function profilerBlindSpot(
  database: string,
  settings: ProfilerSettings | null,
): string | null {
  if (settings === null) {
    return `the profiler's settings on ${database} could not be read, so it may keep only slow operations`;
  }
  if (settings.was >= 2) return null;
  if (settings.was <= 0) return `the profiler on ${database} has since been turned off`;
  if (settings.filter !== undefined) {
    return `the profiler on ${database} keeps only what its filter selects`;
  }
  const rate = settings.sampleRate ?? 1;
  if (settings.slowms <= 0 && rate >= 1) return null;
  const which = rate >= 1 ? "operations" : `a ${Math.round(rate * 100)}% sample of operations`;
  return `the profiler on ${database} keeps only ${which} slower than ${settings.slowms} ms, and a failed one is fast`;
}

// ---------------------------------------------------------------------------
// Keeping a database's profiler on for an observe window (#596).
//
// The failed-operations check needs a profiler that records fast operations, and
// on most clusters there is none: the hosted deployment's one drop ran with the
// profiler off. So for the databases holding a drop in flight, Indexterity turns
// it on itself — level 1, with a FILTER that records failed operations on the
// watched collections and hint() at the indexes about to be hidden, and nothing
// else of its own.
//
// Three facts, each measured on mongod 6.0, 7.0, 8.2 and 9.0, decide the shape:
//
//   - A filter REPLACES `slowms` for the slow-query log as well as for the
//     profiler. With a failures-only filter set, a 250 ms query was neither
//     logged nor profiled. Atlas's Performance Advisor and every log-based tool
//     read that log, so the filter carries a clause that keeps what the database
//     kept before — its own filter if it had one, else `millis >= slowms` with
//     `$sampleRate` — and the log is unchanged.
//   - The filter is per database, and setting it needs `enableProfiler`;
//     reading it (`profile: -1`) needs nothing the role lacks.
//   - `setProfilingLevel(0)` keeps the filter, and a restart clears both. That is
//     what lets a person turning the profiler off be told apart from a restart:
//     level 0 with this marker still in it was somebody's decision, and it is
//     not overridden.
//
// Where the state lives: IN the filter, as a clause that can never match — an
// `ns` equal to a string no namespace can be, because `$` cannot appear in a
// database name. It carries what was there before, so a restore puts back
// exactly that; it survives our own process restarting; and anyone reading
// `db.getProfilingStatus()` sees whose filter it is. The profiler only admits
// its own output fields in a filter (a `__indexterity` field was refused), so
// `ns` it is.
// ---------------------------------------------------------------------------

const MARKER_PREFIX = "indexterity$";

const watchMarker = z.object({
  v: z.literal(1),
  // The cluster registration that set it. Another registration of the same
  // cluster — another org, another install — finds a marker that is not its own,
  // and leaves it alone rather than adopting or restoring somebody else's watch.
  owner: z.string(),
  // The database's profiler before, to put back exactly: its level, and its
  // filter as BSON in base64. Not EJSON, which reads a query operator that shares
  // a name with one of its type wrappers as the type: `{$regex: "^a"}` came back
  // a regex value and `{$date: 5}` threw.
  prior: z.object({ level: z.number(), filter: z.string().nullable() }),
  // The server-wide threshold and sample the kept clause copies when the prior
  // had no filter of its own. Recorded so a changed slowms is noticed and the
  // clause follows it.
  slow: z.object({ ms: z.number(), rate: z.number() }).nullable(),
  // Namespace -> when failures on it started being recorded, epoch ms.
  watch: z.record(z.string(), z.number()),
  // Namespace -> indexes whose hint() is recorded: the ones not hidden yet. A hint
  // at a hidden index fails outright and is caught as a failure.
  hints: z.record(z.string(), z.array(z.string())),
  // Stretches this node recorded nothing although watched, [from, to] in epoch ms
  // (#641): a restart cleared its settings some time after `from`, the last pass
  // that saw them, and the watch was put back at `to` with its starts as they
  // were. Kept here, in the same command that puts the watch back, so the
  // stretch is said by every reading that spans it. Absent when there is none.
  gaps: z.array(z.tuple([z.number(), z.number()])).optional(),
});
export type WatchMarker = z.infer<typeof watchMarker>;

// The marker in a filter as `profile: -1` returns it (normalised — the clause
// comes back as `{ns: {$eq: "indexterity$…"}}`), or null when there is none.
export function markerOf(filter: unknown): WatchMarker | null {
  const found = markerString(filter);
  if (found === null) return null;
  try {
    return watchMarker.safeParse(JSON.parse(found.slice(MARKER_PREFIX.length))).data ?? null;
  } catch {
    return null;
  }
}

function markerString(value: unknown): string | null {
  if (typeof value === "string") return value.startsWith(MARKER_PREFIX) ? value : null;
  const children = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : [];
  for (const child of children) {
    const found = markerString(child);
    if (found !== null) return found;
  }
  return null;
}

// What the database kept before, as one clause of the new filter.
function keptClause(marker: WatchMarker): Document {
  if (marker.prior.filter !== null) return fromStored(marker.prior.filter);
  const slow = marker.slow ?? { ms: 100, rate: 1 };
  const threshold = { millis: { $gte: slow.ms } };
  return slow.rate >= 1 ? threshold : { $and: [threshold, { $sampleRate: slow.rate }] };
}

// The filter a marker stands for. `keys` gives each hinted index's key pattern by
// "ns\0name", for the hints that name an index by its pattern instead.
//
// A hint is recorded in three shapes, all probed: a find or an aggregate keeps
// the name (`"a_1"`), an update or a delete keeps it wrapped (`{$hint: "a_1"}`),
// and either keeps a key-pattern hint as the pattern. `$in` refuses a document
// with a `$` key, so each shape is its own `$eq`.
export function watchFilter(
  marker: WatchMarker,
  keys: ReadonlyMap<string, Document> = new Map(),
): Document {
  const hinted = Object.entries(marker.hints)
    .filter(([, names]) => names.length > 0)
    .map(([ns, names]) => ({
      ns,
      $or: names.flatMap((name) => {
        const pattern = keys.get(`${ns}\u0000${name}`);
        return [
          { "command.hint": { $eq: name } },
          { "command.hint": { $eq: { $hint: name } } },
          ...(pattern === undefined ? [] : [{ "command.hint": { $eq: pattern } }]),
        ];
      }),
    }));
  return {
    $or: [
      keptClause(marker),
      {
        ns: { $in: Object.keys(marker.watch) },
        $or: [{ ok: 0 }, { errCode: { $exists: true } }],
      },
      ...hinted,
      { ns: { $eq: `${MARKER_PREFIX}${JSON.stringify(marker)}` } },
    ],
  };
}

// One step to bring one database's profiler on one node to what is wanted.
export type WatchStep =
  // Already as wanted, or not ours to change.
  | { readonly kind: "KEEP" }
  // Level 1 with `watchFilter(marker)`.
  | { readonly kind: "SET"; readonly marker: WatchMarker }
  // Give it back: this level and filter (`"unset"` clears it).
  | { readonly kind: "RESTORE"; readonly level: number; readonly filter: Document | "unset" }
  // Wanted, and not ours to do.
  | { readonly kind: "DECLINE"; readonly reason: string };

export function planWatch(input: {
  readonly database: string;
  // The cluster registration asking.
  readonly owner: string;
  readonly settings: ProfilerSettings;
  // Namespace -> indexes whose hint() to record. Empty: nothing is wanted here.
  readonly wanted: ReadonlyMap<string, readonly string[]>;
  readonly now: number;
  // What to put back where this node was watching recently and its watch is gone
  // (#641). A restart clears the profiler's settings and nothing else:
  // `system.profile` keeps what it recorded, so what the restart cost is the
  // stretch from `seenAt`, the last pass that saw the watch here, until now — not
  // the day before it. Null: start from now.
  readonly resume?: Resume | null;
}): WatchStep {
  const { database, owner, settings, wanted } = input;
  const marker = markerOf(settings.filter);
  if (marker !== null && marker.owner !== owner) {
    return wanted.size === 0
      ? { kind: "KEEP" }
      : {
          kind: "DECLINE",
          reason: `another Indexterity registration of this cluster has the profiler on ${database}`,
        };
  }
  if (wanted.size === 0) {
    if (marker === null) return { kind: "KEEP" };
    // A level somebody set after us is theirs and stays; only ours goes back.
    return {
      kind: "RESTORE",
      level: settings.was === 1 ? marker.prior.level : settings.was,
      filter: marker.prior.filter === null ? "unset" : fromStored(marker.prior.filter),
    };
  }
  if (marker !== null) {
    // `setProfilingLevel(0)` keeps the filter and a restart clears it, so level 0
    // with our marker still in it was a person — and a person is not overridden.
    if (settings.was === 0) {
      return {
        kind: "DECLINE",
        reason: `the profiler on ${database} was turned off after Indexterity turned it on`,
      };
    }
    // Somebody wants everything recorded, which records failures too.
    if (settings.was >= 2) return { kind: "KEEP" };
    const next = markerFor(
      owner,
      marker.prior,
      settings,
      wanted,
      marker.watch,
      marker.gaps ?? [],
      input.now,
    );
    return sameMarker(next, marker) ? { kind: "KEEP" } : { kind: "SET", marker: next };
  }
  // Records every operation already: nothing to add, and nothing to restore later.
  if (settings.was >= 2) return { kind: "KEEP" };
  const rate = settings.sampleRate ?? 1;
  if (settings.filter === undefined && settings.slowms <= 0) {
    if (settings.was === 1 && rate >= 1) return { kind: "KEEP" };
    // Copying a zero threshold into the kept clause at level 1 would profile every
    // operation on the database, which is not a side effect to take on here.
    return {
      kind: "DECLINE",
      reason: `slowms is 0 on ${database}, so keeping its slow-query log unchanged would profile every operation`,
    };
  }
  const prior = {
    level: settings.was,
    filter:
      settings.filter === undefined
        ? null
        : Buffer.from(BSON.serialize(settings.filter)).toString("base64"),
  };
  const resume = input.resume ?? null;
  return {
    kind: "SET",
    marker: markerFor(
      owner,
      prior,
      settings,
      wanted,
      resume?.starts ?? {},
      resume === null ? [] : [...resume.gaps, [resume.seenAt, input.now]],
      input.now,
    ),
  };
}

// A node's watch to put back as it was (#641).
export interface Resume {
  // Namespace -> since when it has been watched.
  readonly starts: Readonly<Record<string, number>>;
  // When a pass last saw this node watching.
  readonly seenAt: number;
  // The stretches this node had already missed, as its marker carried them.
  readonly gaps: readonly (readonly [number, number])[];
}

function fromStored(filter: string): Document {
  return BSON.deserialize(Buffer.from(filter, "base64"));
}

function markerFor(
  owner: string,
  prior: WatchMarker["prior"],
  settings: ProfilerSettings,
  wanted: ReadonlyMap<string, readonly string[]>,
  watched: Readonly<Record<string, number>>,
  gaps: readonly (readonly [number, number])[],
  now: number,
): WatchMarker {
  const namespaces = [...wanted.keys()].sort();
  // A namespace watched already keeps its start: re-setting the filter to add a
  // neighbour does not restart anybody's baseline.
  const watch = Object.fromEntries(namespaces.map((ns) => [ns, watched[ns] ?? now]));
  // A stretch over before every watch here began is in no reading any more.
  const earliest = Math.min(...Object.values(watch));
  const kept = gaps
    .filter(([, to]) => to > earliest)
    .map(([from, to]): [number, number] => [from, to])
    .sort(([a], [b]) => a - b);
  return {
    v: 1,
    owner,
    prior,
    slow: prior.filter === null ? { ms: settings.slowms, rate: settings.sampleRate ?? 1 } : null,
    watch,
    hints: Object.fromEntries(
      namespaces.map((ns) => [ns, [...new Set(wanted.get(ns) ?? [])].sort()]),
    ),
    // Absent rather than empty, so a marker written before there were gaps reads
    // as the same marker and is not set again for nothing.
    ...(kept.length > 0 ? { gaps: kept } : {}),
  };
}

function sameMarker(a: WatchMarker, b: WatchMarker): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// One row of the failed-operations `$group`: a kind of failure, the hint the
// operation carried, and how many there were. A field the profiler did not record
// is null.
export interface FailureGroup {
  readonly code: number | null;
  readonly name: string | null;
  readonly hint: string | Readonly<Record<string, unknown>> | null;
  readonly failed: number;
}

// A window's failures, sorted, before the ring's reach and settings are added.
export type SortedFailures = Pick<
  FailedOpsWindow,
  "hinted" | "suspect" | "suspectKinds" | "unrelated"
>;

// What a hint at a hidden index fails with — and a hint at an index that never
// existed, with the same message, which is why a hint failure is only evidence
// when the hint names THIS index. Probed on mongod 6.0.28, 7.0.39, 8.2.9 and
// 9.0.2 for find, aggregate, count, findAndModify, update and delete, by name and
// by key pattern (#625).
const BAD_VALUE = 2;

// The other kinds a missing index can cause, each probed on the same four servers
// with the index hidden (#625):
//   - MaxTimeMSExpired (50): a plan slow enough to run out its maxTimeMS — or a
//     driver's `timeoutMS`, which it sends as one.
//   - QueryExceededMemoryLimitNoDiskUseAllowed (292): a sort the index served,
//     done in memory instead, over the limit with `allowDiskUse: false`.
//   - NoQueryExecutionPlans (291): `$text` or `$near` without their index, or a
//     server running `notablescan`.
//   - IndexNotFound (27): `$geoNear` without its index, on 9.0 (291 before).
// Ordinary traffic has all of these too, which is what makes them suspect rather
// than proof. Everything else is the application's own: a duplicate key, a
// document its validator refuses, a malformed query, a client that hung up
// mid-query (237 CursorKilled or 279 ClientDisconnect, by where it had got to).
// A deploy hangs up on its own, and a query slow enough to make a client give up
// reaches the latency gate as a slow one anyway.
const SUSPECT: ReadonlyMap<number, string> = new Map([
  [50, "MaxTimeMSExpired"],
  [292, "QueryExceededMemoryLimitNoDiskUseAllowed"],
  [291, "NoQueryExecutionPlans"],
  [27, "IndexNotFound"],
]);

// The profiler's failures on one namespace, sorted by what could have caused them
// (#625). `index.key` is the index's key pattern, for a hint that names it by its
// pattern — or null when it could not be read, and then any pattern hint counts as
// one at the index: the unknown takes the side that keeps the index.
export function sortFailures(
  groups: readonly FailureGroup[],
  index: { readonly name: string; readonly key: Readonly<Record<string, unknown>> | null },
): SortedFailures {
  let hinted = 0;
  const suspect: { kind: string; failed: number }[] = [];
  const unrelated: { kind: string; failed: number }[] = [];
  for (const group of groups) {
    if (group.code === BAD_VALUE && hintsAt(group.hint, index)) {
      hinted += group.failed;
      continue;
    }
    const known = group.code === null ? undefined : SUSPECT.get(group.code);
    const kind =
      group.name ?? known ?? (group.code === null ? "unnamed errors" : `error ${group.code}`);
    (known === undefined ? unrelated : suspect).push({ kind, failed: group.failed });
  }
  const suspectKinds = mergeTallies([suspect]);
  return {
    hinted,
    suspect: suspectKinds.reduce((sum, { failed }) => sum + failed, 0),
    suspectKinds,
    unrelated: mergeTallies([unrelated]),
  };
}

// Whether a recorded hint names the index. Three shapes, all probed: a find or an
// aggregate keeps the name, an update or a delete keeps it wrapped as
// `{$hint: name}`, and a key-pattern hint stays the pattern — the index's, field
// for field and in order, as mongod itself matches one.
function hintsAt(
  hint: FailureGroup["hint"],
  index: { readonly name: string; readonly key: Readonly<Record<string, unknown>> | null },
): boolean {
  if (hint === null) return false;
  if (typeof hint === "string") return hint === index.name;
  const wrapped = hint.$hint;
  if (typeof wrapped === "string") return wrapped === index.name;
  if (index.key === null) return true;
  const fields = Object.entries(hint);
  const keys = Object.entries(index.key);
  return (
    fields.length === keys.length &&
    fields.every(([field, direction], i) => {
      const key = keys[i];
      return key !== undefined && key[0] === field && key[1] === direction;
    })
  );
}

// Every failure one node's ring recorded, of any kind: what says the profiler was
// on at some point, whatever the failures were.
function recorded(failures: SortedFailures): number {
  return (
    (failures.hinted ?? 0) +
    failures.suspect +
    failures.unrelated.reduce((sum, { failed }) => sum + failed, 0)
  );
}

// How full one node's profiler ring is: its size and entries against its cap.
// `system.profile` is a capped collection, 1 MB unless somebody made it bigger.
export interface RingFill {
  readonly bytes: number;
  readonly entries: number;
  readonly capBytes: number;
  // A cap on the entry count as well, where the ring was created with one.
  readonly capEntries: number | null;
}

// Whether a ring has turned over — deleted its oldest entries to make room — or
// null when its fill could not be read (#625).
//
// Its oldest entry alone cannot say. A ring that has kept everything since the
// watch began also has an oldest entry later than the watch: the first operation
// worth keeping, on a quiet database, may come hours in. Read as the reach, that
// shortened the baseline of a database that had lost nothing.
//
// A ring that has turned over stays within one entry of its cap, probed on mongod
// 6.0.28 and 9.0.2: a 1 MB ring held 1,048,430 and 1,046,791 bytes once it had,
// and 910,751 at a thousand entries before it did. A tenth of the cap is the
// margin, on the side that says it has turned over: a reach claimed further back
// than the ring can see is what rolled a drop back in #625.
export function ringTurnedOver(fill: RingFill | null): boolean | null {
  if (fill === null || fill.capBytes <= 0) return null;
  const full = (count: number, cap: number) => count >= cap * 0.9;
  return (
    full(fill.bytes, fill.capBytes) ||
    (fill.capEntries !== null && full(fill.entries, fill.capEntries))
  );
}

// The ring's listCollections entry, and what `dataSize` answers for it.
const ringOptions = z.object({
  options: z.object({
    capped: z.boolean().optional(),
    size: z.coerce.number().optional(),
    max: z.coerce.number().optional(),
  }),
});
const dataSizeReply = z.object({ size: z.coerce.number(), numObjects: z.coerce.number() });

// How full one node's profiler ring is (#625), or null when it cannot be read.
// `dataSize` with no bounds answers from the collection's own counts, and needs
// only `find` on it; the cap is in the ring's listCollections options. Both are
// readable with the engine role — probed on 7.0, where $collStats on
// system.profile was refused.
export async function ringFillOn(
  conn: MongoConnection,
  database: string,
): Promise<RingFill | null> {
  try {
    const db = conn.db(database);
    const [listed, size] = await Promise.all([
      db.listCollections({ name: "system.profile" }).toArray(),
      db.command({ dataSize: `${database}.system.profile` }),
    ]);
    const ring = ringOptions.safeParse(listed[0]).data;
    const used = dataSizeReply.safeParse(size).data;
    if (ring?.options.capped !== true || ring.options.size === undefined || used === undefined) {
      return null;
    }
    return {
      bytes: used.size,
      entries: used.numObjects,
      capBytes: ring.options.size,
      capEntries: ring.options.max ?? null,
    };
  } catch {
    return null;
  }
}

// The ring's oldest entry, any namespace — its reach — or null when it is empty
// or cannot be read.
export async function oldestProfiledOn(
  conn: MongoConnection,
  database: string,
): Promise<Date | null> {
  try {
    const docs = await conn
      .db(database)
      .collection("system.profile")
      .find({}, { projection: { _id: 0, ts: 1 } })
      .sort({ $natural: 1 })
      .limit(1)
      .toArray();
    return profiledAt.safeParse(docs[0]).data?.ts ?? null;
  } catch {
    return null;
  }
}
const profiledAt = z.object({ ts: z.coerce.date() });

// The instant from which every node's ring still holds what it recorded (#642):
// the latest oldest entry among the rings that have turned over. A ring that has
// not holds everything since its watch began, so it limits nothing; one whose fill
// could not be read is left out rather than guessed at. Null when no ring is known
// to have turned over.
export function ringReach(
  rings: readonly { readonly fill: RingFill | null; readonly oldest: Date | null }[],
): number | null {
  const reaches = rings.flatMap(({ fill, oldest }) =>
    ringTurnedOver(fill) === true && oldest !== null ? [oldest.getTime()] : [],
  );
  return reaches.length === 0 ? null : Math.max(...reaches);
}

// What one node's ring and settings add up to for the failed-operations check
// (#596). Pure over what the collector read, so every case is a unit test.
export function failedOpsReading(read: {
  readonly database: string;
  readonly collection: string;
  // Failures on the namespace since `sinceMs`, sorted (sortFailures).
  readonly failures: SortedFailures;
  readonly sinceMs: number;
  // The ring's oldest entry, any namespace — its reach — or null when it is empty.
  readonly oldest: Date | null;
  // How full the ring is, or null when that could not be read.
  readonly fill: RingFill | null;
  readonly settings: ProfilerSettings | null;
  readonly throughMongos: boolean;
}): FailedOpsReading {
  const { database, failures, oldest, settings } = read;
  // Through mongos the ring read is the database's PRIMARY SHARD's — mongos routes
  // it there — but `profile: -1` answers for mongos itself, which never profiles.
  // Probed on 7.0 with the shard at level 2: mongos said `was: 0`, and the same
  // read returned the shard's failure. So the settings are unknowable from here
  // rather than off, and saying "off" would be wrong.
  if (read.throughMongos) {
    return oldest === null
      ? {
          kind: "NO_SOURCE",
          reason: `${database}'s primary shard has profiled nothing, and mongos cannot say whether its profiler is on`,
        }
      : {
          kind: "WINDOW",
          ...failures,
          reachMs: oldest.getTime(),
          blindSpot: `only ${database}'s primary shard is read, and mongos cannot say how its profiler is set`,
        };
  }
  const marker = markerOf(settings?.filter);
  const since = marker?.watch[`${database}.${read.collection}`];
  // Ours, still on, and watching this collection: complete since the watch began.
  // An empty ring is normal here — a filter that keeps only failures and slow
  // operations keeps nothing on a healthy database — so the reach is the watch's
  // start, not the oldest entry, unless the ring has since turned over. Where its
  // fill cannot be read, the oldest entry stands in, which can only understate it.
  if (since !== undefined && settings?.was === 1) {
    const caveats = [
      // Later than asked about: the watch began after the hide — a restart cleared
      // it longer ago than a watch is put back across, or the index was hidden
      // before Indexterity watched at all — and what failed in between went
      // unrecorded.
      since > read.sinceMs
        ? `the profiler on ${database} has recorded failures only since ${utcMinute(since)}, after the hide`
        : null,
      // A restart this node's watch was put back across (#641): its start held,
      // and the stretch it missed is said instead.
      missedClause(
        database,
        (marker?.gaps ?? []).filter(([, to]) => to > read.sinceMs),
      ),
    ].filter((caveat) => caveat !== null);
    return {
      kind: "WINDOW",
      ...failures,
      reachMs:
        ringTurnedOver(read.fill) === false ? since : Math.max(since, oldest?.getTime() ?? since),
      blindSpot: caveats.length === 0 ? null : caveats.join("; "),
    };
  }
  // Ours, and turned off by somebody since: what it recorded until then counts.
  if (since !== undefined && settings?.was === 0) {
    const off = `the profiler on ${database} was turned off after Indexterity turned it on`;
    return recorded(failures) === 0 || oldest === null
      ? { kind: "NO_SOURCE", reason: off }
      : {
          kind: "WINDOW",
          ...failures,
          reachMs: Math.max(since, oldest.getTime()),
          blindSpot: off,
        };
  }
  // Off, and nothing from when it was on says otherwise. Failures recorded before
  // somebody turned it off are still failures, so those still count.
  if (settings?.was === 0 && recorded(failures) === 0) {
    return { kind: "NO_SOURCE", reason: `the profiler is off on ${database}` };
  }
  if (oldest === null) {
    return { kind: "NO_SOURCE", reason: `the profiler on ${database} has recorded nothing yet` };
  }
  return {
    kind: "WINDOW",
    ...failures,
    reachMs: oldest.getTime(),
    blindSpot: profilerBlindSpot(database, settings),
  };
}

// What a node missed to restarts its watch was put back across (#641), as a
// clause — or null when it missed nothing. The restart's own instant is unknown:
// it came after the last pass that saw the watch and before the one that put it
// back, so that is the stretch named, and the failures said to be missing are the
// ones after the restart within it.
export function missedClause(
  database: string,
  gaps: readonly (readonly [number, number])[],
): string | null {
  const [first] = gaps;
  const last = gaps.at(-1);
  if (first === undefined || last === undefined) return null;
  if (gaps.length === 1) {
    return (
      `a restart cleared the profiler on ${database} between ${utcMinute(first[0])} and ` +
      `${utcMinute(first[1])}, so failures from the restart until ${utcMinute(first[1])} were not recorded`
    );
  }
  const most = gaps.reduce((sum, [from, to]) => sum + (to - from), 0);
  return (
    `restarts cleared the profiler on ${database} ${gaps.length} times between ` +
    `${utcMinute(first[0])} and ${utcMinute(last[1])}, so failures in up to ${span(most)} of ` +
    "that were not recorded"
  );
}

// Every node's reading as one (#596). A replica set's profiler is per member — a
// filter set through the set's connection reached only the primary, and a failing
// read routed to a secondary was recorded in that secondary's ring alone — so the
// check reads each member and adds them up.
//
// The reach is the LATEST of theirs, the instant from which every member can
// vouch; a member with no source makes the whole a partial window rather than
// none, since the others still saw what they saw. The same sentence from every
// member is said once, and only a member that differs is named.
export function combineReadings(
  readings: readonly { readonly host: string; readonly reading: FailedOpsReading }[],
): FailedOpsReading {
  const [only] = readings;
  if (only === undefined) return { kind: "NO_SOURCE", reason: "no member could be read" };
  if (readings.length === 1) return only.reading;
  const windows = readings.flatMap(({ reading }) => (reading.kind === "WINDOW" ? [reading] : []));
  const caveats = readings.map(({ host, reading }) => ({
    host,
    text: reading.kind === "WINDOW" ? reading.blindSpot : reading.reason,
  }));
  const said = (texts: readonly { host: string; text: string | null }[]): string | null => {
    const present = texts.filter((entry) => entry.text !== null);
    if (present.length === 0) return null;
    const distinct = new Set(present.map((entry) => entry.text));
    if (distinct.size === 1 && present.length === texts.length) return present[0]?.text ?? null;
    return present.map((entry) => `on ${entry.host}, ${entry.text}`).join("; ");
  };
  if (windows.length === 0) {
    return { kind: "NO_SOURCE", reason: said(caveats) ?? "no member could be read" };
  }
  return {
    kind: "WINDOW",
    hinted: windows.reduce<number | null>(
      (sum, window) => (sum === null || window.hinted === null ? null : sum + window.hinted),
      0,
    ),
    suspect: windows.reduce((sum, window) => sum + window.suspect, 0),
    suspectKinds: mergeTallies(windows.map((window) => window.suspectKinds)),
    unrelated: mergeTallies(windows.map((window) => window.unrelated)),
    reachMs: Math.max(...windows.map((window) => window.reachMs)),
    blindSpot: said(caveats),
  };
}
