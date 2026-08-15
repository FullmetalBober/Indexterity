import type { IndexDirection, IndexSpec } from "./types";

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

// Every column an index can produce without leaving its own leaves: the key
// columns plus whatever it carries alongside them.
function coveredColumns(index: IndexSpec): Set<string> {
  return new Set([...index.keys.map((key) => key.field), ...(index.include ?? [])]);
}

// Does `other` carry everything `candidate` could answer on its own?
//
// A wider key list is not automatically a wider INDEX. `(customer_id) INCLUDE
// (total)` answers `SELECT total WHERE customer_id = ?` from the index alone;
// `(customer_id, status)` has the longer key and cannot answer it at all, so
// the query falls back to the table. Measured on SQL Server 2022 over 200k
// rows: 6 logical reads with the covering index present, 1124 once it was
// gone — the prefix rule alone would have proposed exactly that trade.
//
// True for an index with no includes, which is every MongoDB index and most
// SQL Server ones: nothing to carry over means nothing to lose.
export function coversIncludes(candidate: IndexSpec, other: IndexSpec): boolean {
  const includes = candidate.include ?? [];
  if (includes.length === 0) return true;
  const covered = coveredColumns(other);
  return includes.every((column) => covered.has(column));
}

// A direction that describes an ORDER, and therefore has a reverse. `text`,
// `hashed` and `2dsphere` do not — nothing walks them backwards to produce a
// different sequence — so they are only ever covered by an identical key.
function ordered(direction: IndexDirection): direction is 1 | -1 {
  return direction === 1 || direction === -1;
}

// Do `other`'s leading keys walk the same ORDER as `candidate`'s — key for key,
// or as its exact full reverse?
//
// The reverse half is not a relaxation of the rule, it IS the rule, and both
// engines have it. An index is read backwards to serve the exact inversion of
// its own key pattern, so `(a DESC, b DESC, c ASC)` yields `a ASC, b ASC` on a
// backward walk and `(a ASC, b ASC)` was never buying anything.
//
// Measured rather than reasoned about (#207), on SQL Server 2022 CU26 and
// mongod 8.2.9, with ONLY the wide inverted index present:
//
//   ORDER BY a          no Sort, walked backward     both engines
//   ORDER BY a DESC     no Sort, walked forward      both engines
//   ORDER BY a, b       no Sort, walked backward     both engines
//   a = 5 ORDER BY b    no Sort                      both engines
//   ORDER BY a, b DESC  SORT                         both engines
//
// That last row is why this is all-or-nothing across the prefix and never per
// key: a MIXED requirement is the one neither walk produces, and accepting it
// per key would propose dropping an index that is genuinely load-bearing.
//
// The issue that prompted this expected an engine-conditional rule, with SQL
// Server reversing where mongod would not. The two engines answered identically
// on every case above, so there is no flag here — the direction rules are the
// same, and the old check was simply stricter than either engine.
export function coversKeyOrder(candidate: IndexSpec, other: IndexSpec): boolean {
  const pairs: { want: IndexDirection; have: IndexDirection }[] = [];
  for (const [i, key] of candidate.keys.entries()) {
    const otherKey = other.keys[i];
    if (otherKey === undefined || otherKey.field !== key.field) return false;
    pairs.push({ want: key.direction, have: otherKey.direction });
  }
  if (pairs.every(({ want, have }) => have === want)) return true;
  return pairs.every(({ want, have }) => ordered(want) && ordered(have) && have === -want);
}

// True when `other` covers `candidate`'s order only by being read BACKWARDS.
// Worth telling apart from the key-for-key case purely so the finding can say
// it: the two indexes read as opposites on the screen, and "key-prefix of X"
// against an index whose every direction is the other way looks like a bug in
// the engine rather than a fact about b-trees.
export function servedByBackwardWalk(candidate: IndexSpec, other: IndexSpec): boolean {
  if (!coversKeyOrder(candidate, other)) return false;
  return candidate.keys.some((key, i) => other.keys[i]?.direction !== key.direction);
}

// Raw structural check: `candidate`'s keys are a proper prefix of `other`'s in
// an order `other` can produce, under the same collation. Says nothing about
// options (unique/TTL/…) or about covered columns — that's isRedundantPrefix's
// job.
export function isKeyPrefix(candidate: IndexSpec, other: IndexSpec): boolean {
  if (candidate.name === other.name) return false;
  if (candidate.keys.length >= other.keys.length) return false;
  if (candidate.collation !== other.collation) return false;
  return coversKeyOrder(candidate, other);
}

// True when `candidate` is a proper key-prefix of `other` with matching key
// directions, compatible options, and every column `candidate` covers also
// carried by `other` — i.e. `other` already covers it.
export function isRedundantPrefix(candidate: IndexSpec, other: IndexSpec): boolean {
  if (!optionsCompatible(candidate, other)) return false;
  if (!coversIncludes(candidate, other)) return false;
  return isKeyPrefix(candidate, other);
}

// NOTE: an "exact duplicate" rule (same keys, different name) was built and then
// removed — mongod itself rejects that create (IndexKeySpecsConflict), so true
// duplicates cannot exist. The real-world twin is same-keys-different-COLLATION,
// which is legal but not yet modeled in IndexSpec; flagging it without collation
// awareness would be a false positive. See the README roadmap.
//
// SQL Server's own twin — same keys, one index's includes a superset of the
// other's — is legal and genuinely wasteful, and is deliberately NOT flagged
// here: isKeyPrefix wants a PROPER prefix, so equal key lists never reach the
// rule. Proposing that drop is a new finding rather than a guard on this one,
// and it belongs with the evidence a new finding needs.
