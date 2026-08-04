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
    return { safe: false, reason: "index is now protected (unique/ttl/shard/_id_)", spec };
  }
  if (target.type === "DROP_REDUNDANT") {
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
