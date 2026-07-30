import type { RecommendationType } from "@repo/contracts";
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

// A distinct query pattern from $queryStats/the profiler, split for the ESR
// rule: equality predicates, then sort keys (with directions), then ranges.
export interface QueryShape {
  readonly equality: readonly string[];
  readonly sort: readonly SortKey[];
  readonly range: readonly string[];
  readonly collscan: boolean;
  readonly count: number;
  readonly constants?: Readonly<Record<string, ConstantValue>>;
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

// Propose index additions from collection-scan query shapes. Pure. The caller
// should only pass shapes from non-trivial collections (size gate lives there).
//  - UPDATE: an existing index is a proper prefix of the wanted keys -> extend it
//  - MERGE:  two+ single-field indexes cover the wanted fields -> one compound
//  - CREATE: otherwise a brand-new index
// Never retires a never-drop index (unique/TTL/shard/_id_). Existing-index
// matching is by field names (a single-key sort is servable by backward scan);
// only emitted keys carry directions.
export function recommendCreates(
  shapes: readonly QueryShape[],
  existing: readonly IndexSpec[],
  options: WorkloadOptions,
): CreateCandidate[] {
  const candidates: CreateCandidate[] = [];
  const seen = new Set<string>();
  for (const shape of shapes) {
    if (!shape.collscan || shape.count < options.minCount) continue;
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
    const wanted = wantedKeys.map((key) => key.field);
    const wantedKey = wantedKeys.map((key) => `${key.field}:${key.direction}`).join(",");
    if (seen.has(wantedKey)) continue;
    seen.add(wantedKey);
    if (existing.some((idx) => equalFields(fieldsOf(idx), wanted))) continue;

    const scan = `collection scan seen ${shape.count}×`;
    const extendable = existing.find((idx) => !isNeverDrop(idx) && isPrefix(fieldsOf(idx), wanted));
    const singles = existing.filter(
      (idx) =>
        !isNeverDrop(idx) && idx.keys.length === 1 && wanted.includes(fieldsOf(idx)[0] ?? ""),
    );

    if (extendable !== undefined) {
      candidates.push({
        type: "UPDATE",
        keys: wantedKeys,
        retireIndexes: [extendable.name],
        rationale: `Extend ${extendable.name} to {${describe(wantedKeys)}} — ${scan}.`,
        count: shape.count,
      });
    } else if (singles.length >= 2) {
      candidates.push({
        type: "MERGE",
        keys: wantedKeys,
        retireIndexes: singles.map((idx) => idx.name),
        rationale: `Replace ${singles.map((idx) => idx.name).join(" + ")} with a compound index on {${describe(wantedKeys)}} — ${scan}.`,
        count: shape.count,
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
        count: shape.count,
        ...(partialFilter === undefined ? {} : { partialFilter }),
      });
    }
  }
  return candidates;
}
