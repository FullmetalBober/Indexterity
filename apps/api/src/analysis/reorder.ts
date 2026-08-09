import { isNeverDrop } from "./safety";
import type { IndexSpec } from "./types";
import {
  esrKeys,
  isRecurring,
  type QueryShape,
  type SortKey,
  type WorkloadOptions,
} from "./workload";

// Re-ordering a PROTECTED index's keys, where only the direction changes.
//
// A unique index's guarantee is a property of its key SET, not of its key
// DIRECTIONS: `{a: 1, b: 1}` unique and `{a: 1, b: -1}` unique enforce exactly
// the same constraint. Verified against mongod 8.2 rather than reasoned about —
// both indexes coexist, a duplicate is refused while both are present, and after
// dropping the ascending one the descending one still refuses it.
//
// That is what makes this a change the engine can propose at all. Everywhere
// else, a protected index is protected because removing it removes something no
// latency gate can detect; here nothing is removed. The constraint survives the
// swap, and it survives it at every instant, because the replacement is built
// BEFORE the original is retired.
//
// The addressable set is much smaller than "unique indexes", and each exclusion
// is a fact about MongoDB rather than a policy:
//
//   single-field    MongoDB walks an index in either direction, so `{a: 1}`
//                   already serves `sort({a: -1})`. Direction only means
//                   anything BETWEEN the keys of a compound index. Most unique
//                   indexes in the wild are single-field (email, slug, external
//                   id) and are out of scope by construction.
//   TTL             single-field only in MongoDB, so there is never a direction
//                   to change.
//   shard key       cannot be dropped, and a hashed shard key cannot be
//                   re-ordered.
//   _id_            cannot be modified at all.
//   text/hashed/    not ordered fields, so "direction" does not apply.
//   2dsphere
//
// Which leaves exactly one target: a COMPOUND UNIQUE index whose direction
// pattern cannot serve a sort the workload actually performs.

// Where a shape's ordering requirement lands in the key list its ESR order
// implies, and which direction it wants there.
//
// Not simply "the sort keys": a field with an EQUALITY predicate is pinned to
// one value, so the index's direction at that position is irrelevant — measured
// on mongod 8.2, where `{a:1,b:1,c:1}` serves `find({a:1}).sort({b:-1,c:-1})`
// from the index and `find({}).sort({a:1,b:-1})` does not. esrKeys already drops
// a sort key that equality has claimed; this walks the same order and reports
// only the positions that genuinely constrain a direction.
export function orderingPositions(shape: QueryShape): { position: number; direction: 1 | -1 }[] {
  const out: { position: number; direction: 1 | -1 }[] = [];
  const seen = new Set<string>();
  let position = 0;
  for (const field of shape.equality) {
    if (seen.has(field)) continue;
    seen.add(field);
    position += 1;
  }
  for (const key of shape.sort) {
    if (seen.has(key.field)) continue;
    seen.add(key.field);
    out.push({ position, direction: key.direction });
    position += 1;
  }
  return out;
}

// Can this index's directions serve this shape's ordering? The sort block must
// match identically or be exactly inverted — a backward scan reverses every key
// at once, so it can serve the whole reversal and nothing in between.
export function servesShapeOrder(index: IndexSpec, shape: QueryShape): boolean {
  const positions = orderingPositions(shape);
  if (positions.length === 0) return true;
  const directions = positions.map(({ position }) => index.keys[position]?.direction);
  if (directions.some((direction) => direction !== 1 && direction !== -1)) return false;
  const same = positions.every((want, i) => directions[i] === want.direction);
  const inverted = positions.every((want, i) => directions[i] === -want.direction);
  return same || inverted;
}

function fieldsOf(index: IndexSpec): string[] {
  return index.keys.map((key) => key.field);
}

function equalFields(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((field, i) => b[i] === field);
}

function describe(keys: readonly SortKey[]): string {
  return keys.map((key) => `${key.field}: ${key.direction}`).join(", ");
}

// Is this index one a direction change could even apply to?
//
// Deliberately NOT "is it protected": the drop side's isNeverDrop is a list of
// reasons an index must not be REMOVED, and this removes nothing. What matters
// here is whether a direction exists to change and whether the swap is
// physically possible at all.
export function isReorderable(index: IndexSpec): boolean {
  if (index.name === "_id_") return false;
  // A hashed shard key cannot be re-ordered, and no shard-key index can be
  // dropped — so the old one could never be retired.
  if (index.isShardKey) return false;
  // Single-field indexes gain nothing: the server reads one in either direction.
  if (index.keys.length < 2) return false;
  // TTL is single-field in MongoDB, so this is unreachable rather than a policy
  // — stated anyway, because "unreachable" is a property of the server that a
  // future version could change.
  if (index.ttl) return false;
  if (index.keys.some((key) => key.direction !== 1 && key.direction !== -1)) return false;
  // Everything left that the engine may not simply drop and rebuild elsewhere.
  // Today that is exactly the unique indexes; the test asserts it, so a new
  // never-drop reason cannot silently fall through to here.
  return isNeverDrop(index);
}

export interface ReorderCandidate {
  // The protected index whose directions do not match.
  readonly indexName: string;
  // What to build instead: the same fields, in the same order, with the
  // directions the workload needs. Every other option is carried from the
  // original — see `spec`.
  readonly keys: readonly SortKey[];
  // The original, so the caller can carry `unique`, `partialFilterExpression`,
  // `sparse` and `collation` over verbatim. A dropped option here is a silently
  // weakened constraint, which is the one outcome this must never produce.
  readonly spec: IndexSpec;
  readonly count: number;
  readonly rationale: string;
}

// The direction pattern to build, given what the index has now and what one
// shape needs.
//
// Two patterns serve any given sort — the shape's own directions, and their
// exact inverse — so the one closer to the index as it stands wins. Fewer keys
// change, which means fewer OTHER shapes are disturbed, and a reader comparing
// the two specs sees the smallest edit that does the job.
function targetDirections(index: IndexSpec, shape: QueryShape): SortKey[] {
  const positions = orderingPositions(shape);
  const build = (invert: boolean): SortKey[] =>
    index.keys.map((key, i) => {
      const want = positions.find(({ position }) => position === i);
      const direction: 1 | -1 =
        want === undefined
          ? // Not an ordering position, so its direction constrains nothing —
            // keep whatever is there rather than normalising it away.
            key.direction === -1
            ? -1
            : 1
          : invert
            ? (-want.direction as 1 | -1)
            : want.direction;
      return { field: key.field, direction };
    });
  const flips = (keys: readonly SortKey[]): number =>
    keys.reduce((count, key, i) => count + (index.keys[i]?.direction === key.direction ? 0 : 1), 0);
  const straight = build(false);
  const reversed = build(true);
  return flips(reversed) < flips(straight) ? reversed : straight;
}

// Propose a direction change on a protected compound index whose key order
// cannot serve a sort the workload performs.
//
// Pure. `hinted` names the indexes the application pins with hint(), which the
// caller reads from live state (the profiler) — the rule lives here because it
// is a HARD VETO rather than a scoring penalty, and it is the one veto whose
// absence would be silent: `.hint("a_1_b_1")` against an index that is now
// `a_1_b_-1` is an ERROR, not a slower query, and the default index NAME
// encodes the directions, so a hint by name breaks as surely as one by key
// pattern. Nothing downstream would catch it either — the post-build watch
// measures write latency, and the broken queries would already have stopped.
export function recommendReorder(
  shapes: readonly QueryShape[],
  existing: readonly IndexSpec[],
  options: WorkloadOptions,
  hinted: ReadonlySet<string> = new Set(),
): ReorderCandidate[] {
  const recurring = shapes.filter((shape) => isRecurring(shape, options));
  const candidates: ReorderCandidate[] = [];
  for (const index of existing) {
    if (!isReorderable(index)) continue;
    if (hinted.has(index.name)) continue;
    const fields = fieldsOf(index);
    // Shapes this index is the natural answer to: same fields, same order.
    // Anything else is a different index's business, and a shape whose fields
    // merely overlap says nothing about which directions these keys want.
    const covered = recurring.filter((shape) =>
      equalFields(
        esrKeys(shape).map((k) => k.field),
        fields,
      ),
    );
    const blocked = covered.filter(
      (shape) => shape.sortedInMemory === true && !servesShapeOrder(index, shape),
    );
    if (blocked.length === 0) continue;
    // The most-run blocked shape decides the target pattern. Serving the
    // busiest one is the whole of the gain, and a second pattern cannot be
    // served by the same index anyway.
    const driver = [...blocked].sort((a, b) => b.count - a.count)[0];
    if (driver === undefined) continue;
    const keys = targetDirections(index, driver);
    const proposed: IndexSpec = { ...index, keys };
    // Would the flip break a shape this index serves TODAY? Nothing measures
    // that afterwards: the post-build watch is a WRITE-latency gate, so a read
    // this quietly pushed into an in-memory sort would never be noticed. Which
    // one to keep is then a judgement about the workload rather than a free
    // improvement, and the engine does not make it.
    const wouldBreak = covered.filter(
      (shape) => servesShapeOrder(index, shape) && !servesShapeOrder(proposed, shape),
    );
    if (wouldBreak.length > 0) continue;
    const count = blocked.reduce((sum, shape) => sum + shape.count, 0);
    candidates.push({
      indexName: index.name,
      keys,
      spec: index,
      count,
      rationale:
        `${index.name} covers these fields but not in an order that serves the sort, so the ` +
        `server orders the results in memory (seen ${count}×). Rebuild it as ` +
        `{${describe(keys)}} — the SAME KEYS in the same order, with the directions the query ` +
        `needs. This index is unique, and the uniqueness is preserved: a unique index ` +
        `constrains its key SET, not its key directions, so both patterns enforce exactly the ` +
        `same rule. The replacement is built FIRST and the original is only retired once it ` +
        `has survived its post-build watch, so there is no moment when the constraint is not ` +
        `being enforced by one of them. Every other option — unique, the partial filter, ` +
        `sparse, the collation — is carried over unchanged.`,
    });
  }
  return candidates;
}
