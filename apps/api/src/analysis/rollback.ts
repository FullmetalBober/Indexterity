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
