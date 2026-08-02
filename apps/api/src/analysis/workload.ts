import type { RecommendationType } from "@repo/contracts";
import { isWorthIndexing, type QueryClient } from "./client";
import { isNeverDrop } from "./safety";
import type { IndexSpec } from "./types";

export interface SortKey {
  readonly field: string;
  readonly direction: 1 | -1;
}

// A primitive an equality predicate compared against in EVERY sample of a
// shape — the signal for a partial index. Only the profiler carries real
// values ($queryStats shapifies them away), so this is often empty.
export type ConstantValue = string | number | boolean;

// A $lookup join observed in an aggregation: the foreign collection and the
// field it is joined on — the signal for a foreign-side index.
export interface LookupJoin {
  readonly from: string;
  readonly foreignField: string;
}

// A distinct query pattern from $queryStats/the profiler, split for the ESR
// rule: equality predicates, then sort keys (with directions), then ranges.
export interface QueryShape {
  readonly equality: readonly string[];
  readonly sort: readonly SortKey[];
  readonly range: readonly string[];
  readonly collscan: boolean;
  readonly count: number;
  // Documents the server actually walked for this shape, when the workload
  // source reports it ($queryStats does; the profiler does not). The measure of
  // what a missing index is costing — see analysis/severity.ts.
  readonly docsExamined?: number;
  // Who issued this shape. $queryStats groups by client as well as by shape,
  // so a query run from a shell and the same query from an app arrive as
  // separate entries; merged shapes accumulate every client seen. Empty on
  // the profiler path, which reports no client.
  readonly clients?: readonly QueryClient[];
  readonly constants?: Readonly<Record<string, ConstantValue>>;
  // $lookup joins anywhere in the pipeline (indexed on the FOREIGN collection).
  readonly lookups?: readonly LookupJoin[];
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
  // When set, build a partial index: these constant equality predicates move
  // into partialFilterExpression and out of the keys — smaller index, same query.
  readonly partialFilter?: Readonly<Record<string, ConstantValue>>;
}

export interface WorkloadOptions {
  readonly minCount: number;
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

interface Want {
  readonly shape: QueryShape;
  readonly wantedKeys: SortKey[];
  readonly partialFilter?: Readonly<Record<string, ConstantValue>>;
  absorbedCount: number;
  absorbedShapes: number;
}

// Propose index additions from collection-scan query shapes. Pure. The caller
// should only pass shapes from non-trivial collections (size gate lives there).
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
  const seen = new Set<string>();
  const wants: Want[] = [];
  for (const shape of shapes) {
    if (!shape.collscan || shape.count < options.minCount) continue;
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
    if (seen.has(wantedKey)) continue;
    seen.add(wantedKey);
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
    wants.push({ shape, wantedKeys, partialFilter, absorbedCount: 0, absorbedShapes: 0 });
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
      `collection scan seen ${count}×` +
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
        ...keepFilter,
      });
    } else if (singles.length >= 2) {
      candidates.push({
        type: "MERGE",
        keys: wantedKeys,
        retireIndexes: singles.map((idx) => idx.name),
        rationale: `Replace ${singles.map((idx) => idx.name).join(" + ")} with a compound index on {${describe(wantedKeys)}} — ${scan}.`,
        count,
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
        ...(partialFilter === undefined ? {} : { partialFilter }),
      });
    }
  }
  return candidates;
}
