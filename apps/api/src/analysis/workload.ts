import type { RecommendationType } from "@repo/contracts";
import type { ConstantValue, IndexSpec, QueryShape, SortKey } from "../engine/types";
import { isWorthIndexing } from "./client";
import { isNeverDrop } from "./safety";

const HOURS_PER_WEEK = 168;

// How often this shape runs, per week.
//
// An unmeasurable window is not a rate of zero. Where the source cannot say how
// long it watched, the count is all there is and the count stands in for the
// rate — the same judgement made everywhere else a window is missing, rather
// than a silent refusal to ever act.
export function executionsPerWeek(shape: QueryShape): number {
  const hours = shape.observedForHours;
  if (hours === undefined || hours <= 0) return shape.count;
  return shape.count / (hours / HOURS_PER_WEEK);
}

// Does this shape recur often enough to act on?
//
// Both tests have to pass, and they catch different mistakes. The count floor
// rejects the query someone ran twice by hand; the rate rejects the one that
// ran five times in two months and would otherwise look identical to it.
export function isRecurring(shape: QueryShape, options: WorkloadOptions): boolean {
  if (shape.count < options.minCount) return false;
  const hours = shape.observedForHours;
  if (hours === undefined || hours <= 0) return true;
  return executionsPerWeek(shape) >= options.minPerWeek;
}

// The ESR key: Equality fields first, then Sort, then Range — the order that
// lets a single index serve the whole query. Equality/range keys are ascending
// (direction is irrelevant for point/range bounds); sort keys keep their own
// directions so the index can serve the sort without an in-memory stage.
// Deduped, first occurrence wins.
export function esrKeys(shape: QueryShape): SortKey[] {
  const ordered: SortKey[] = [];
  const seen = new Set<string>();
  const push = (field: string, direction: 1 | -1) => {
    if (seen.has(field)) return;
    seen.add(field);
    ordered.push({ field, direction });
  };
  for (const field of shape.equality) push(field, 1);
  for (const key of shape.sort) push(key.field, key.direction);
  for (const field of shape.range) push(field, 1);
  return ordered;
}

export interface CreateCandidate {
  readonly type: RecommendationType; // CREATE | UPDATE | MERGE
  readonly keys: readonly SortKey[];
  readonly retireIndexes: readonly string[];
  readonly rationale: string;
  // The observed frequency behind this candidate (feeds the confidence score).
  readonly count: number;
  // Whether a collection scan is behind this candidate, as opposed to only an
  // in-memory sort. Both are worth an index; a scan is the stronger argument,
  // and the only one allowed to skip the change window.
  readonly scanning: boolean;
  // When set, build a partial index: these constant equality predicates move
  // into partialFilterExpression and out of the keys — smaller index, same query.
  readonly partialFilter?: Readonly<Record<string, ConstantValue>> | undefined;
}

export interface WorkloadOptions {
  // Absolute floor. Two sightings are a coincidence whatever the window.
  readonly minCount: number;
  // And a rate, because the floor alone means different things on the two
  // sources. `$queryStats` accumulates for the life of the store — often
  // months — so three executions there is a handful of runs and nothing more.
  // The profiler is a capped ring that a busy collection fills in minutes, so
  // three executions there can be three a minute. One number, two windows
  // differing by orders of magnitude, and no way to tell them apart from the
  // count alone.
  readonly minPerWeek: number;
}

function fieldsOf(index: IndexSpec): string[] {
  return index.keys.map((key) => key.field);
}

function isPrefix(shorter: readonly string[], longer: readonly string[]): boolean {
  if (shorter.length === 0 || shorter.length >= longer.length) return false;
  return shorter.every((field, i) => longer[i] === field);
}

function equalFields(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((field, i) => b[i] === field);
}

function describe(keys: readonly SortKey[]): string {
  return keys.map((key) => (key.direction === -1 ? `${key.field}: -1` : key.field)).join(", ");
}

// True when a's directed keys are a PROPER prefix of b's — an index on b
// serves every query an index on a would.
function isDirectedPrefix(a: readonly SortKey[], b: readonly SortKey[]): boolean {
  if (a.length >= b.length) return false;
  return a.every((key, i) => b[i]?.field === key.field && b[i]?.direction === key.direction);
}

// Do two indexes cover the same documents? Both unfiltered, or both filtered on
// exactly the same thing. Key order in the expression is irrelevant, so compare
// sorted entries rather than the objects.
//
// Deliberately exact: `{status:"active"}` and `{status:{$in:["active"]}}` select
// the same documents but are not recognised as equal here. Deciding that one
// filter implies another is predicate implication, which is a real research
// problem — exact matches are the subset that is provably safe.
function sameFilter(
  a: Readonly<Record<string, unknown>> | null | undefined,
  b: Readonly<Record<string, unknown>> | null | undefined,
): boolean {
  const left = a ?? null;
  const right = b ?? null;
  if (left === null || right === null) return left === right;
  const canonical = (filter: Readonly<Record<string, unknown>>): string =>
    JSON.stringify(Object.entries(filter).sort(([x], [y]) => x.localeCompare(y)));
  return canonical(left) === canonical(right);
}

// Can this index's key order serve that sort? Directly, or read backwards —
// a backward scan reverses EVERY key, so {a:1,b:1} serves sort({a:-1,b:-1})
// but not sort({a:1,b:-1}). A text/hashed/2dsphere key orders nothing, so an
// index carrying one is never the answer to a sort.
function servesOrder(index: IndexSpec, wanted: readonly SortKey[]): boolean {
  if (index.keys.length !== wanted.length) return false;
  const directions: (1 | -1)[] = [];
  for (const key of index.keys) {
    if (key.direction !== 1 && key.direction !== -1) return false;
    directions.push(key.direction);
  }
  const matches = (reversed: boolean): boolean =>
    index.keys.every((key, i) => {
      const want = wanted[i];
      const direction = directions[i];
      if (want === undefined || direction === undefined) return false;
      return want.field === key.field && want.direction === (reversed ? -direction : direction);
    });
  return matches(false) || matches(true);
}

// An index already covers these fields, but in an order that cannot serve the
// sort — so the server sorts in memory anyway and no create is proposed, since
// the fix is a second index differing only in direction.
//
// Building that automatically is a bigger call than this engine makes unasked:
// two near-identical indexes double the write cost of the collection, and which
// one to keep is a judgement about the workload. Reported instead of silently
// dropped, which is what happened before.
//
// PROTECTED indexes are included, and they were not. `!isNeverDrop(idx)`
// excluded them from being a blocker, and recommendCreates suppresses the
// create whenever an index covers the fields — with no such exclusion — so a
// unique index with the wrong directions produced NOTHING AT ALL: not a create,
// not an advisory. The engine had a finding and said nothing about it. Where a
// re-order can fix one properly, jobs/suggest.ts proposes that instead of this;
// where it cannot — hinted, or another shape relies on the current directions —
// this is what a human gets, which is what the silence was costing them.
export interface SortOrderAdvisory {
  readonly existingIndex: string;
  readonly wantedKeys: readonly SortKey[];
  readonly count: number;
}

export function sortOrderAdvisories(
  shapes: readonly QueryShape[],
  existing: readonly IndexSpec[],
  options: WorkloadOptions,
): SortOrderAdvisory[] {
  const out: SortOrderAdvisory[] = [];
  const seen = new Set<string>();
  for (const shape of shapes) {
    if (shape.sortedInMemory !== true || !isRecurring(shape, options)) continue;
    if (shape.sort.length === 0) continue;
    if (!isWorthIndexing(shape.clients ?? [])) continue;
    const wantedKeys = esrKeys(shape);
    if (wantedKeys.length === 0) continue;
    const wanted = wantedKeys.map((key) => key.field);
    const blocker = existing.find(
      (idx) => equalFields(fieldsOf(idx), wanted) && !servesOrder(idx, wantedKeys),
    );
    if (blocker === undefined) continue;
    const key = `${blocker.name}\u0000${wantedKeys.map((k) => `${k.field}:${k.direction}`).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ existingIndex: blocker.name, wantedKeys, count: shape.count });
  }
  return out;
}

interface Want {
  readonly shape: QueryShape;
  readonly wantedKeys: SortKey[];
  readonly partialFilter?: Readonly<Record<string, ConstantValue>> | undefined;
  scanning: boolean;
  absorbedCount: number;
  absorbedShapes: number;
}

// Propose index additions from query shapes the server is working too hard to
// serve: collection scans, and queries that reach their documents through an
// index but then sort them in memory. Pure. The caller should only pass shapes
// from non-trivial collections (size gate lives there).
//  - UPDATE: an existing index is a proper prefix of the wanted keys -> extend it
//  - MERGE:  two+ single-field indexes cover the wanted fields -> one compound
//  - CREATE: otherwise a brand-new index
// Wants that are a directed prefix of another want CONSOLIDATE into the wider
// one (one index serves both shapes; the wider inherits the narrower's counts).
// Partial candidates never consolidate — a partial index only serves queries
// matching its filter. Never retires a never-drop index (unique/TTL/shard/_id_).
// Existing-index matching is by field names (a single-key sort is servable by
// backward scan); only emitted keys carry directions.
export function recommendCreates(
  shapes: readonly QueryShape[],
  existing: readonly IndexSpec[],
  options: WorkloadOptions,
): CreateCandidate[] {
  const seen = new Map<string, Want>();
  const wants: Want[] = [];
  for (const shape of shapes) {
    const sorting = shape.sortedInMemory === true;
    if ((!shape.collscan && !sorting) || !isRecurring(shape, options)) continue;
    // Someone exploring at a prompt is not a workload. The index would be
    // maintained on every write for years, for queries nobody runs again.
    if (!isWorthIndexing(shape.clients ?? [])) continue;
    let wantedKeys = esrKeys(shape);
    if (wantedKeys.length === 0) continue;
    // Constant equality predicates (same literal in every sample) become a
    // partialFilterExpression instead of index keys — but only when other keys
    // remain to index; a filter with nothing to index stays a normal candidate.
    const constants = shape.constants ?? {};
    const constantFields = Object.keys(constants).filter((field) => shape.equality.includes(field));
    let partialFilter: Readonly<Record<string, ConstantValue>> | undefined;
    if (
      constantFields.length > 0 &&
      wantedKeys.some((key) => !constantFields.includes(key.field))
    ) {
      const filter: Record<string, ConstantValue> = {};
      for (const field of constantFields) {
        const value = constants[field];
        if (value !== undefined) filter[field] = value;
      }
      partialFilter = filter;
      wantedKeys = wantedKeys.filter((key) => !constantFields.includes(key.field));
    }
    const wantedKey = wantedKeys.map((key) => `${key.field}:${key.direction}`).join(",");
    const already = seen.get(wantedKey);
    if (already !== undefined) {
      // Two shapes wanting the same index. One candidate covers both, but a
      // scan behind either of them is a scan behind the candidate.
      already.scanning = already.scanning || shape.collscan;
      continue;
    }
    // An index on exactly these fields already exists. For a scanning shape
    // that means the planner chose not to use it, which an extra index would
    // not fix. For a sorting shape it means the directions cannot serve the
    // sort — a real finding, but the fix is a second index differing only in
    // direction, and proposing that automatically is a bigger call than this
    // engine should make unasked.
    if (
      existing.some((idx) =>
        equalFields(
          fieldsOf(idx),
          wantedKeys.map((key) => key.field),
        ),
      )
    ) {
      continue;
    }
    const want: Want = {
      shape,
      wantedKeys,
      partialFilter,
      scanning: shape.collscan,
      absorbedCount: 0,
      absorbedShapes: 0,
    };
    seen.set(wantedKey, want);
    wants.push(want);
  }

  // Consolidation: fold prefix wants into the widest want that covers them,
  // narrowest first so chains ({a} ⊂ {a,b} ⊂ {a,b,c}) collapse fully.
  wants.sort((a, b) => a.wantedKeys.length - b.wantedKeys.length);
  const survivors: Want[] = [];
  for (const want of wants) {
    const covers = wants.filter(
      (other) =>
        other !== want &&
        want.partialFilter === undefined &&
        other.partialFilter === undefined &&
        isDirectedPrefix(want.wantedKeys, other.wantedKeys),
    );
    const widest = covers.at(-1);
    if (widest !== undefined) {
      widest.absorbedCount += want.shape.count + want.absorbedCount;
      widest.absorbedShapes += 1 + want.absorbedShapes;
      widest.scanning = widest.scanning || want.scanning;
      continue;
    }
    survivors.push(want);
  }

  const candidates: CreateCandidate[] = [];
  for (const want of survivors) {
    const { shape, wantedKeys, partialFilter } = want;
    const wanted = wantedKeys.map((key) => key.field);
    const count = shape.count + want.absorbedCount;
    const scan =
      (want.scanning ? `collection scan seen ${count}×` : `in-memory sort seen ${count}×`) +
      (want.absorbedShapes > 0
        ? ` (also serves ${want.absorbedShapes} narrower shape${want.absorbedShapes === 1 ? "" : "s"})`
        : "");
    // Only indexes covering the SAME documents may be extended or merged into
    // this want. For a full want that means full indexes: narrowing an existing
    // index to a filtered subset would strand every query outside the filter,
    // and the index may well be serving exactly those. For a partial want it
    // means partial indexes with an identical filter — same keys and same
    // documents, so folding them together loses nothing.
    const compatible = (idx: IndexSpec): boolean =>
      !isNeverDrop(idx) && sameFilter(idx.partialFilter, partialFilter);
    const extendable = existing.find((idx) => compatible(idx) && isPrefix(fieldsOf(idx), wanted));
    const singles = existing.filter(
      (idx) => compatible(idx) && idx.keys.length === 1 && wanted.includes(fieldsOf(idx)[0] ?? ""),
    );

    // The replacement keeps the want's filter — the retired indexes carry the
    // same one, so the documents covered do not change.
    const keepFilter = partialFilter === undefined ? {} : { partialFilter };

    if (extendable !== undefined) {
      candidates.push({
        type: "UPDATE",
        keys: wantedKeys,
        retireIndexes: [extendable.name],
        rationale: `Extend ${extendable.name} to {${describe(wantedKeys)}} — ${scan}.`,
        count,
        scanning: want.scanning,
        ...keepFilter,
      });
    } else if (singles.length >= 2) {
      candidates.push({
        type: "MERGE",
        keys: wantedKeys,
        retireIndexes: singles.map((idx) => idx.name),
        rationale: `Replace ${singles.map((idx) => idx.name).join(" + ")} with a compound index on {${describe(wantedKeys)}} — ${scan}.`,
        count,
        scanning: want.scanning,
        ...keepFilter,
      });
    } else {
      const partialNote =
        partialFilter === undefined
          ? ""
          : ` Partial: only documents where ${Object.entries(partialFilter)
              .map(([field, value]) => `${field} = ${JSON.stringify(value)}`)
              .join(", ")} — smaller index, same query.`;
      candidates.push({
        type: "CREATE",
        keys: wantedKeys,
        retireIndexes: [],
        rationale: `Add an index on {${describe(wantedKeys)}} — ${scan}.${partialNote}`,
        count,
        scanning: want.scanning,
        ...(partialFilter === undefined ? {} : { partialFilter }),
      });
    }
  }
  return candidates;
}

// An index wider than anything actually asks for.
//
// The mirror of the UPDATE rule: that one extends {a} to {a,b} when a query
// needs both. This one proposes {a,b} in place of {a,b,c} when no observed
// shape ever reaches the third key. There is no correctness gain — {a,b,c}
// already serves every {a,b} query — only size and a cheaper write path, since
// every insert maintains one fewer key.
//
// Why it is not simply the redundancy rule in reverse: redundancy is structural
// and provable from the index list alone, and it always keeps the WIDER index.
// This is the opposite call and rests entirely on workload evidence, so it is
// only sound where that evidence is trustworthy — the caller must pass shapes
// from a real workload source, not an empty list.
//
// $indexStats counts hits per index, never per key, so "nothing uses the third
// key" cannot be read off usage. It has to come from the shapes.
export interface NarrowCandidate {
  readonly indexName: string;
  readonly keys: readonly SortKey[];
  readonly droppedKeys: readonly string[];
  // Total executions behind the shapes that actually reach this index. The
  // measure of how much watching is behind the claim, and the only defence
  // against narrowing on a thin sample — see analysis/score.ts.
  readonly observedCount: number;
  readonly rationale: string;
}

// Does this shape use this index at all? True when the index's first key is the
// shape's first ESR key: that is the one position MongoDB cannot work around,
// since a scan has to start somewhere.
function reaches(index: IndexSpec, shape: QueryShape): boolean {
  return index.keys[0]?.field === esrKeys(shape)[0]?.field;
}

// Every field a shape mentions, in any role. Deliberately NOT the ESR prefix
// depth: with equality on `a` and a bound on `c`, MongoDB scans {a,b,c} across
// the whole `b` range and applies the `c` bound inside the index. So `c` is
// doing work even though nothing matches the index prefix past position 0, and
// a prefix-depth rule would happily propose dropping it.
function mentionedFields(shape: QueryShape): string[] {
  return [...shape.equality, ...shape.sort.map((key) => key.field), ...shape.range];
}

// An index wider than anything actually asks for.
//
// Only TRAILING keys go, and only ones no reaching shape mentions anywhere. A
// gap in the middle stays: {a,b,c} where nothing uses `b` still needs `b` in
// place for `c` to be reachable at all.
export function recommendNarrowing(
  shapes: readonly QueryShape[],
  existing: readonly IndexSpec[],
  options: WorkloadOptions,
): NarrowCandidate[] {
  // A one-off query must not pin an index's shape forever, so both sides of the
  // argument need recurrence. The client filter is applied to only ONE of them,
  // and the asymmetry is the point: elsewhere, discarding shell traffic makes
  // the engine do less. Here it would make it do MORE — every discarded shape
  // is one that can no longer defend a key. So interactive traffic cannot
  // JUSTIFY narrowing, but it can still PREVENT it. A nightly report run
  // through mongosh is a person at a prompt by every signal available and a
  // real recurring query all the same.
  const recurring = shapes.filter((shape) => isRecurring(shape, options));
  const worth = recurring.filter((shape) => isWorthIndexing(shape.clients ?? []));
  // No evidence, no narrowing. An empty workload makes every index look
  // over-wide, which is the most expensive possible way to be wrong.
  if (worth.length === 0) return [];

  const candidates: NarrowCandidate[] = [];
  for (const index of existing) {
    // Never-drop indexes keep their shape: a unique constraint or a shard key
    // makes the trailing keys load-bearing for something other than reads.
    if (isNeverDrop(index) || index.keys.length < 2) continue;
    // Rebuilding a text/hashed/2dsphere key from a shape list is not something
    // to attempt — those keys are not ordinary ordered fields.
    if (index.keys.some((key) => key.direction !== 1 && key.direction !== -1)) continue;

    const reaching = worth.filter((shape) => reaches(index, shape));
    // Nothing an application runs reaches it. Either the index is unused —
    // which the drop side decides with far better evidence than this — or the
    // workload sample missed it entirely. Both mean silence.
    if (reaching.length === 0) continue;
    const touched = new Set(
      recurring.filter((shape) => reaches(index, shape)).flatMap(mentionedFields),
    );

    let lastUsed = -1;
    index.keys.forEach((key, i) => {
      if (touched.has(key.field)) lastUsed = i;
    });
    if (lastUsed < 0 || lastUsed >= index.keys.length - 1) continue;

    const keys = index.keys.slice(0, lastUsed + 1).flatMap((key) =>
      // Redundant after the guard above, but it is what convinces the compiler
      // the direction is 1 | -1 rather than a text/hashed marker.
      key.direction === 1 || key.direction === -1
        ? [{ field: key.field, direction: key.direction }]
        : [],
    );
    const dropped = index.keys.slice(lastUsed + 1).map((key) => key.field);
    const plural = dropped.length === 1 ? "key" : "keys";
    candidates.push({
      indexName: index.name,
      keys,
      droppedKeys: dropped,
      observedCount: reaching.reduce((sum, shape) => sum + shape.count, 0),
      rationale:
        `Replace ${index.name} with an index on {${describe(keys)}} — across every query seen ` +
        `using it, nothing mentions its trailing ${plural} ` +
        `${dropped.map((field) => `\`${field}\``).join(", ")}. Same queries served, a smaller ` +
        `index, and one fewer ${plural} to maintain on every write to this collection. ` +
        `CAUTION: this rests on the ABSENCE of evidence, so verify against anything that runs ` +
        `too rarely to reach the workload sample — particularly a query sorting on ` +
        `${dropped.map((field) => `\`${field}\``).join(" or ")}, which would fall back to an ` +
        `in-memory sort. The old index is hidden first and restored automatically if reads ` +
        `regress, but a blocking sort over 100 MB fails outright rather than running slowly.`,
    });
  }
  return candidates;
}
