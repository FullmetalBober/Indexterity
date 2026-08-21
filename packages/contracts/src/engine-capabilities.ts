import type { ClusterEngine } from "./schemas.js";

// Which engines have reversible index invisibility, for the dashboard's wording.
//
// Separate from the api's `EngineCapabilities.hideIndexes` for the same reason
// engine-hint.ts is separate from `detectEngine`: the authority is the adapter,
// and the browser cannot import it. What this is allowed to decide is what a
// sentence SAYS — "hide, drop and build" versus "drop and build", and whether a
// disconnect promises to restore anything. What it must never decide is whether
// the pipeline hides, which `openClusterSession` answers from the registry.
//
// Held to the adapters by a test in the api (`engine/registry.test.ts`) that
// compares this table against every supported adapter's own capability, because
// this is exactly the kind of pair that drifts silently — an adapter shipped
// without a hide would otherwise keep promising one on the disconnect dialog for
// a release before anybody noticed.
const HIDE_INDEXES: Readonly<Record<ClusterEngine, boolean>> = {
  // collMod hidden:true — instant and free both ways.
  MONGODB: true,
  // ALTER INDEX … DISABLE hides instantly; the un-hide is a REBUILD, which is
  // exact but not instant. Still reversible, so still a hide.
  MSSQL: true,
  // No native equivalent, and the one mechanism that works (clearing
  // `pg_index.indisvalid`) needs superuser and cannot be delegated — measured on
  // 17.11 and 18.6 for #35. The observe stage is statistics-only here: the index
  // keeps serving every query while the window runs. Its adapter has shipped, so
  // registry.test.ts now holds this value against the adapter itself rather than
  // asserting it ahead of one.
  POSTGRESQL: false,
};

export function canHideIndexes(engine: ClusterEngine): boolean {
  return HIDE_INDEXES[engine];
}
