import type { IndexSpec } from "./types";

// A unique/partial/sparse/TTL index does more than accelerate reads, so it can
// never be folded away as "covered by a superset".
function optionsCompatible(candidate: IndexSpec, other: IndexSpec): boolean {
  if (candidate.unique && !other.unique) return false;
  if (candidate.partial || candidate.sparse || candidate.ttl) return false;
  // The covering index has to actually cover. Sharing a key prefix is not
  // enough when `other` is itself restricted:
  //
  //   partial - indexes only the documents matching its filter, so queries
  //             outside that filter would fall back to a collection scan;
  //   sparse  - skips documents missing the field entirely;
  //   hidden  - the planner will not use it at all, and our own drop pipeline
  //             hides an index for the whole observe window, which would
  //             otherwise make every prefix of it look redundant right when it
  //             is least able to serve anything.
  //
  // TTL is deliberately absent: it expires documents but indexes all of them,
  // so a TTL superset covers its prefix fine.
  if (other.partial || other.sparse || other.hidden) return false;
  // A prefix under a different collation is NOT covered — collation-dependent
  // queries (case-insensitive string comparison etc.) can only use the index
  // whose collation matches.
  if (candidate.collation !== other.collation) return false;
  return true;
}

// Raw structural check: `candidate`'s keys are a proper prefix of `other`'s
// with matching directions and the same collation. Says nothing about options
// (unique/TTL/…) — that's isRedundantPrefix's job.
export function isKeyPrefix(candidate: IndexSpec, other: IndexSpec): boolean {
  if (candidate.name === other.name) return false;
  if (candidate.keys.length >= other.keys.length) return false;
  if (candidate.collation !== other.collation) return false;
  return candidate.keys.every((key, i) => {
    const otherKey = other.keys[i];
    return (
      otherKey !== undefined && otherKey.field === key.field && otherKey.direction === key.direction
    );
  });
}

// True when `candidate` is a proper key-prefix of `other` with matching key
// directions and compatible options — i.e. `other` already covers it.
export function isRedundantPrefix(candidate: IndexSpec, other: IndexSpec): boolean {
  if (!optionsCompatible(candidate, other)) return false;
  return isKeyPrefix(candidate, other);
}

// NOTE: an "exact duplicate" rule (same keys, different name) was built and then
// removed — mongod itself rejects that create (IndexKeySpecsConflict), so true
// duplicates cannot exist. The real-world twin is same-keys-different-COLLATION,
// which is legal but not yet modeled in IndexSpec; flagging it without collation
// awareness would be a false positive. See the README roadmap.
