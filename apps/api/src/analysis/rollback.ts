import type { CreateIndexOptions } from "../engine/ports";
import type { IndexSpec } from "./types";

// createIndex key document for rebuilding a dropped index from its stored spec.
// Null when the spec can't be rebuilt automatically (special key types — never
// the case for indexes we drop, since never-drop excludes them, but stay honest).
export function rebuildKeys(spec: IndexSpec): Record<string, 1 | -1> | null {
  const keys: Record<string, 1 | -1> = {};
  for (const key of spec.keys) {
    if (key.direction !== 1 && key.direction !== -1) return null;
    keys[key.field] = key.direction;
  }
  return spec.keys.length > 0 ? keys : null;
}

// And everything else the index was, so an undo restores it rather than an
// approximation of it.
//
// This used to carry the name and the collation and nothing else, which was
// sound only because never-drop meant a unique, sparse or partial index could
// never be dropped in the first place. The re-order path (analysis/reorder.ts)
// makes exactly one of those droppable, and an undo that rebuilt it without
// `unique` would put the collection back with its constraint quietly gone —
// which is the one outcome that whole feature exists to avoid. So the options
// travel with the spec, for every undo rather than for that one.
export function rebuildOptions(spec: IndexSpec): CreateIndexOptions {
  return {
    name: spec.name,
    ...(spec.unique ? { unique: true } : {}),
    ...(spec.sparse ? { sparse: true } : {}),
    ...(spec.collation === null ? {} : { collation: { locale: spec.collation } }),
    ...(spec.partialFilter === null ? {} : { partialFilterExpression: spec.partialFilter }),
  };
}
