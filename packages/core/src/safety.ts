import type { IndexSpec } from "./types";

// Indexes that must never be auto-dropped regardless of usage. Zero query ops
// does NOT mean unused for unique/TTL/shard-key indexes. When unsure, keep.
export function isNeverDrop(index: IndexSpec): boolean {
  if (index.name === "_id_") return true;
  if (index.unique) return true;
  if (index.ttl) return true;
  if (index.isShardKey) return true;
  if (index.partial || index.sparse) return true;
  return false;
}
