import type { IndexSpec } from "./types";

// A unique/partial/sparse/TTL index does more than accelerate reads, so it can
// never be folded away as "covered by a superset".
function optionsCompatible(candidate: IndexSpec, other: IndexSpec): boolean {
  if (candidate.unique && !other.unique) return false;
  if (candidate.partial || candidate.sparse || candidate.ttl) return false;
  return true;
}

// True when `candidate` is a proper key-prefix of `other` with matching key
// directions and compatible options — i.e. `other` already covers it.
export function isRedundantPrefix(candidate: IndexSpec, other: IndexSpec): boolean {
  if (candidate.name === other.name) return false;
  if (candidate.keys.length >= other.keys.length) return false;
  if (!optionsCompatible(candidate, other)) return false;
  return candidate.keys.every((key, i) => {
    const otherKey = other.keys[i];
    return (
      otherKey !== undefined && otherKey.field === key.field && otherKey.direction === key.direction
    );
  });
}

// NOTE: an "exact duplicate" rule (same keys, different name) was built and then
// removed — mongod itself rejects that create (IndexKeySpecsConflict), so true
// duplicates cannot exist. The real-world twin is same-keys-different-COLLATION,
// which is legal but not yet modeled in IndexSpec; flagging it without collation
// awareness would be a false positive. See the README roadmap.
