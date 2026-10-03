import type { SortKey } from "../engine/types";
import { type PlanPurge, purgesOfPlan } from "./delete-patterns";
import {
  compactShapes,
  type MissingIndexSuggestion,
  type PlanShapeFacts,
  type PlanTableShape,
  parsePlanXml,
  shapesOfPlan,
} from "./workload";

// What suggest reads off a Query Store plan's XML, read once per plan and kept
// (#588).
//
// suggest used to ship up to 5,000 plans' XML per database on every pass and
// parse every one of them again, and to scan every plan's XML server-side once
// per table for delete patterns. On the production 12-database SQL Server that
// could not fit in a five-minute budget however it was paced. What a plan says
// — the shapes, the server's own missing-index suggestion, the purges — never
// changes for a given `(plan_id, query_plan_hash)`, exactly like the tables the
// collect attributes latency by (D138), so it is remembered beside them in the
// same entry and a warm suggest ships only the plans it has not seen.

/** Everything suggest reads off one plan. */
export interface PlanWorkload extends PlanShapeFacts {
  readonly purges: readonly PlanPurge[];
}

/** The shapes, suggestions and purges of one plan, from one parse. */
export function workloadOfPlan(planXml: string, database: string): PlanWorkload {
  const tree = parsePlanXml(planXml);
  const { shapes, missing } = compactShapes(shapesOfPlan(tree, database));
  const purges = purgesOfPlan(tree, database);
  // Most plans have no suggestion and no purge, and many no shape: an empty list
  // is one shared instance rather than three allocations per plan.
  return {
    shapes: shapes.length === 0 ? NO_SHAPES : shapes.map(internShape),
    missing: missing.length === 0 ? NO_SUGGESTIONS : missing.map(internSuggestion),
    purges: purges.length === 0 ? NO_PURGES : purges.map(internPurge),
  };
}

// Identifiers, held once. A store of five thousand plans over forty tables names
// the same forty tables and their columns thousands of times, and each plan's
// copy is a fresh string out of the parser — so every name and every column list
// a fact keeps is replaced by one shared instance. Bounded by the schemas the
// process reads, not by the plans: a new plan over a known table adds nothing.
const names = new Map<string, string>();
const lists = new Map<string, readonly string[]>();
const sorts = new Map<string, readonly SortKey[]>();
const NONE: readonly string[] = Object.freeze([]);
const NO_SORT: readonly SortKey[] = Object.freeze([]);
const NO_SHAPES: readonly PlanTableShape[] = Object.freeze([]);
const NO_SUGGESTIONS: readonly MissingIndexSuggestion[] = Object.freeze([]);
const NO_PURGES: readonly PlanPurge[] = Object.freeze([]);

export function internName(name: string): string {
  const held = names.get(name);
  if (held !== undefined) return held;
  names.set(name, name);
  return name;
}

export function internNames(list: readonly string[]): readonly string[] {
  if (list.length === 0) return NONE;
  // NUL cannot occur in an identifier, so the joined key is unambiguous.
  const key = list.join("\u0000");
  const held = lists.get(key);
  if (held !== undefined) return held;
  const fresh = Object.freeze(list.map(internName));
  lists.set(key, fresh);
  return fresh;
}

// A sort is a short list of keys that recurs plan after plan, so it is shared
// whole, like a column list.
function internSort(sort: readonly SortKey[]): readonly SortKey[] {
  if (sort.length === 0) return NO_SORT;
  const key = sort.map((entry) => `${entry.field}\u0000${entry.direction}`).join("\u0001");
  const held = sorts.get(key);
  if (held !== undefined) return held;
  const fresh = Object.freeze(
    sort.map(
      (entry): SortKey =>
        Object.freeze({ field: internName(entry.field), direction: entry.direction }),
    ),
  );
  sorts.set(key, fresh);
  return fresh;
}

function internShape(shape: PlanTableShape): PlanTableShape {
  return {
    ...shape,
    table: internName(shape.table),
    equality: internNames(shape.equality),
    range: internNames(shape.range),
    sort: internSort(shape.sort),
  };
}

function internSuggestion(suggestion: MissingIndexSuggestion): MissingIndexSuggestion {
  return {
    table: internName(suggestion.table),
    equality: internNames(suggestion.equality),
    range: internNames(suggestion.range),
  };
}

function internPurge(purge: PlanPurge): PlanPurge {
  return { ...purge, table: internName(purge.table), field: internName(purge.field) };
}
