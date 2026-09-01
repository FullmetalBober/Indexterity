import type { ClusterEngine, ClusterIndexRow } from "./schemas.js";

// What an index's flags are CALLED on the engine that reported them (#431).
//
// The stored spec is one fixed set of booleans (engine/types.ts, `IndexSpec`)
// because the analysis core has to reason about every engine in one vocabulary.
// A screen has the opposite problem: three of those booleans mean three
// different objects depending on who set them, and one of them is never set at
// all on an engine that has no such concept. Drawing "sparse: no" beside a
// PostgreSQL index is a MongoDB vocabulary with two engines' blanks in it, which
// is what #431 asked this not to be.
//
// So the rule here is: a flag is drawn only when it is SET, and it is worded for
// the engine that set it. Nothing renders a flag an engine cannot express,
// because such a flag is never true — which is a property of the adapters, and
// the reason each entry below names the line that makes it so:
//
//   ttl        MongoDB only. `postgres/collector.ts` and `mssql/collector.ts`
//              both write `ttl: false` unconditionally; neither engine has an
//              index that deletes rows, and age-based deletion there is a job
//              somebody runs (which is what delete-patterns.ts looks for).
//   sparse     MongoDB only, same two lines. Postgres indexes every row
//              including NULL keys, and the equivalent — a partial index whose
//              predicate is IS NOT NULL — is already reported as partial.
//   hidden     Not PostgreSQL: there is no reversible hide, and the one
//              mechanism that works needs superuser (D106), so its collector
//              writes `hidden: false` always. SQL Server's disabled index is
//              the same lifecycle slot and gets that engine's word for it.
//   include    SQL Server only; the other adapters omit the key entirely.
//   isShardKey The port's "the cluster does not work without this" flag, and
//              the three engines mean three things by it — a shard key, a
//              primary key, a clustered index. This is the one that would
//              actively mislead rather than merely look empty.
//
// Wording lives in contracts rather than in the api for the reason
// engine-capabilities.ts gives: the browser cannot import the adapter, and what
// this decides is what a sentence SAYS, never what the pipeline does.

// A flag as drawn: the word, and what it means on this engine in one clause.
export interface IndexFlagLabel {
  readonly label: string;
  readonly title: string;
}

const UNIQUE: IndexFlagLabel = {
  label: "unique",
  title: "Duplicate keys are refused — never dropped automatically",
};
const PARTIAL: IndexFlagLabel = {
  label: "partial",
  title: "Indexes only the rows matching its predicate",
};
const TTL: IndexFlagLabel = {
  label: "TTL",
  title: "Deletes documents once they age past its window",
};
const SPARSE: IndexFlagLabel = {
  label: "sparse",
  title: "Skips documents that do not have the field",
};

// Per engine, because these are the three that differ.
const HIDDEN: Readonly<Record<ClusterEngine, IndexFlagLabel>> = {
  MONGODB: {
    label: "hidden",
    title: "Invisible to the planner (collMod hidden) — still maintained",
  },
  MSSQL: {
    label: "disabled",
    title: "Invisible to the planner and not maintained — re-enabling rebuilds it",
  },
  // Never set; kept so the record is total and a future hide has somewhere to
  // land rather than falling through to a MongoDB word.
  POSTGRESQL: { label: "hidden", title: "Invisible to the planner" },
};

const STRUCTURAL: Readonly<Record<ClusterEngine, IndexFlagLabel>> = {
  MONGODB: {
    label: "shard key",
    title: "The shard key's index — the cluster does not route without it",
  },
  POSTGRESQL: {
    label: "primary key",
    title: "The primary key's index — the server refuses to drop it",
  },
  MSSQL: { label: "clustered", title: "The clustered index IS the table's storage" },
};

// Every flag this index has, in the engine's own words, biggest consequence
// first: the two that stop a drop outright, then the ones that narrow what the
// index covers, then the ones about its current state.
//
// Takes the row rather than a bag of booleans so a flag added to the row cannot
// be forgotten here — the call site passes the whole thing and this file is the
// only place that decides what to say about it.
export function indexFlags(
  row: Pick<ClusterIndexRow, "unique" | "ttl" | "partial" | "sparse" | "hidden" | "isShardKey">,
  engine: ClusterEngine,
): IndexFlagLabel[] {
  const flags: IndexFlagLabel[] = [];
  if (row.isShardKey) flags.push(STRUCTURAL[engine]);
  if (row.unique) flags.push(UNIQUE);
  if (row.partial) flags.push(PARTIAL);
  if (row.sparse) flags.push(SPARSE);
  if (row.ttl) flags.push(TTL);
  if (row.hidden) flags.push(HIDDEN[engine]);
  return flags;
}

// The key pattern as one line: `status: 1, created: -1`.
//
// Directions are printed as the adapter reported them, so `2dsphere` and `text`
// appear as themselves rather than being coerced to a number they are not.
export function keyPattern(keys: ClusterIndexRow["keys"]): string {
  return keys.map((key) => `${key.field}: ${key.direction}`).join(", ");
}
