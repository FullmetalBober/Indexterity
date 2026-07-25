import type { RecommendationType } from "@repo/contracts";
import { isNeverDrop } from "./safety";
import type { IndexSpec } from "./types";

// A distinct query pattern from the profiler, split for the ESR rule: equality
// predicates, then sort fields, then range predicates.
export interface QueryShape {
  readonly equality: readonly string[];
  readonly sort: readonly string[];
  readonly range: readonly string[];
  readonly collscan: boolean;
  readonly count: number;
}

// The ESR key: Equality fields first, then Sort, then Range — the order that lets
// a single index serve the whole query. Deduped, first occurrence wins.
export function esrFields(shape: QueryShape): string[] {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const field of [...shape.equality, ...shape.sort, ...shape.range]) {
    if (!seen.has(field)) {
      seen.add(field);
      ordered.push(field);
    }
  }
  return ordered;
}

export interface CreateCandidate {
  readonly type: RecommendationType; // CREATE | UPDATE | MERGE
  readonly keys: readonly string[];
  readonly retireIndexes: readonly string[];
  readonly rationale: string;
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

// Propose index additions from collection-scan query shapes. Pure. The caller
// should only pass shapes from non-trivial collections (size gate lives there).
//  - UPDATE: an existing index is a proper prefix of the wanted keys -> extend it
//  - MERGE:  two+ single-field indexes cover the wanted fields -> one compound
//  - CREATE: otherwise a brand-new index
// Never retires a never-drop index (unique/TTL/shard/_id_).
export function recommendCreates(
  shapes: readonly QueryShape[],
  existing: readonly IndexSpec[],
  options: WorkloadOptions,
): CreateCandidate[] {
  const candidates: CreateCandidate[] = [];
  const seen = new Set<string>();
  for (const shape of shapes) {
    if (!shape.collscan || shape.count < options.minCount) continue;
    const wanted = esrFields(shape);
    if (wanted.length === 0) continue;
    const wantedKey = wanted.join(",");
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
        keys: wanted,
        retireIndexes: [extendable.name],
        rationale: `Extend ${extendable.name} to {${wanted.join(", ")}} — ${scan}.`,
      });
    } else if (singles.length >= 2) {
      candidates.push({
        type: "MERGE",
        keys: wanted,
        retireIndexes: singles.map((idx) => idx.name),
        rationale: `Replace ${singles.map((idx) => idx.name).join(" + ")} with a compound index on {${wanted.join(", ")}} — ${scan}.`,
      });
    } else {
      candidates.push({
        type: "CREATE",
        keys: wanted,
        retireIndexes: [],
        rationale: `Add an index on {${wanted.join(", ")}} — ${scan}.`,
      });
    }
  }
  return candidates;
}
