import { type IndexSpec, isNeverDrop, isRedundantPrefix } from "../analysis";
import type { IndexCollector } from "../mongo";

export interface PreflightResult {
  readonly safe: boolean;
  readonly reason: string;
  readonly spec: IndexSpec | null;
}

interface DropTarget {
  readonly type: string;
  readonly database: string;
  readonly collection: string;
  readonly indexName: string;
  // Set only on the row that retires a re-ordered index (jobs/finalize.ts).
  readonly targetSpec?: { readonly supersededBy?: string } | null;
}

// Is `replacement` an index that enforces everything `original` enforced?
//
// The whole of the re-order feature's safety rests on this function, so it is
// deliberately exact and deliberately narrow. Same fields in the same ORDER —
// only the directions may differ — and every option identical. A direction
// change preserves a unique constraint because the constraint is a property of
// the key SET (verified against mongod 8.2: with both present a duplicate is
// refused, and after dropping the original the replacement still refuses it).
// Nothing else here is allowed to differ, because nothing else is provably
// equivalent: a different partial filter covers different documents, a
// different collation compares them differently, and a sparse index skips ones
// the dense one indexes.
export function enforcesTheSame(original: IndexSpec, replacement: IndexSpec): boolean {
  if (replacement.name === original.name) return false;
  if (replacement.keys.length !== original.keys.length) return false;
  if (!replacement.keys.every((key, i) => original.keys[i]?.field === key.field)) return false;
  if (replacement.keys.some((key) => key.direction !== 1 && key.direction !== -1)) return false;
  if (replacement.unique !== original.unique) return false;
  if (replacement.sparse !== original.sparse) return false;
  if (replacement.collation !== original.collation) return false;
  if (
    JSON.stringify(replacement.partialFilter ?? null) !==
    JSON.stringify(original.partialFilter ?? null)
  ) {
    return false;
  }
  // A hidden index enforces its constraint but answers no query, so retiring
  // the original against one would be correct and useless — and it is also the
  // shape a half-finished rollback leaves behind.
  if (replacement.hidden) return false;
  return true;
}

// Re-check live Mongo state right before executing a drop (the wiki's
// Architecture page, Apply pipeline) — the world may have changed since the
// recommendation was proposed.
export async function preflightDrop(
  collector: IndexCollector,
  target: DropTarget,
): Promise<PreflightResult> {
  const specs = await collector.listIndexes(target.database, target.collection);
  const spec = specs.find((candidate) => candidate.name === target.indexName) ?? null;
  if (spec === null) {
    return { safe: false, reason: "index no longer exists", spec: null };
  }
  if (isNeverDrop(spec)) {
    // The one exemption, and it is not a class exemption: this row names the
    // index that replaced it, and the claim is checked HERE, against what is on
    // the cluster now. If the replacement was itself dropped, hidden, or built
    // differently in the meantime, the drop is refused and the original stays —
    // which is the whole reason the check lives at the last possible moment
    // rather than at proposal time.
    const replacementName = target.targetSpec?.supersededBy;
    if (replacementName === undefined) {
      return { safe: false, reason: "index is now protected (unique/ttl/shard/_id_)", spec };
    }
    const replacement = specs.find((candidate) => candidate.name === replacementName) ?? null;
    if (replacement === null) {
      return {
        safe: false,
        reason: `the replacement ${replacementName} is not on the cluster, so dropping this would remove its constraint`,
        spec,
      };
    }
    if (!enforcesTheSame(spec, replacement)) {
      return {
        safe: false,
        reason: `${replacementName} no longer matches this index's keys and options, so it cannot be assumed to enforce the same rule`,
        spec,
      };
    }
  }
  if (target.type === "DROP_REDUNDANT" && target.targetSpec?.supersededBy === undefined) {
    const covering = specs.find((other) => isRedundantPrefix(spec, other));
    if (covering === undefined) {
      return { safe: false, reason: "covering index no longer present", spec };
    }
  }
  if (target.type === "DROP_UNUSED") {
    const usage = await collector.collectUsage(target.database, target.collection);
    const ops = usage
      .filter((stat) => stat.indexName === spec.name)
      .reduce((sum, stat) => sum + stat.ops, 0);
    if (ops > 0) {
      return { safe: false, reason: `index now has ${ops} recent ops`, spec };
    }
  }
  return { safe: true, reason: "ok", spec };
}
