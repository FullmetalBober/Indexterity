import type { IndexDirection, IndexSpec } from "../engine/types";

// Key directions whose index is the only way its own queries run at all, so
// hiding one does not make those queries slower — it makes them FAIL.
//
// Measured on mongod 7.0.39, each index hidden with collMod:
//
//   text      $text            NoQueryExecutionPlans (291)
//   2dsphere  $near/$geoNear   NoQueryExecutionPlans (291)
//   2d        $near            NoQueryExecutionPlans (291)
//   2dsphere  $geoWithin       served, by falling back to a collection scan
//   hashed    equality         served, by falling back to a collection scan
//
// That is not a bigger version of the usual risk, it is the assumption the whole
// apply pipeline rests on being false. Hide → observe → drop works because a
// hidden index is a reversible experiment whose result is readable in the
// counters: if something needed it, reads get slower and the regression gate
// un-hides. Here the experiment takes the application down instead, and every
// gate reads that outage as the answer it was hoping for — $indexStats stays at
// zero because the query never reaches the index, and the failed reads are
// FASTER than the baseline they are measured against (159 µs/op against
// 245 µs/op on the same server), so evaluateRegression returns STABLE and the
// drop graduates. Nothing in the pipeline observes errors.
//
// So this is a taxonomy rule, in a file whose own comment below argues against
// taxonomy rules. The distinction that earns it: partial and sparse were
// delisted because low usage is merely EXPECTED for them and measurement is the
// better tool, which presumes measurement is available. For these it is not.
//
// `hashed` is deliberately absent. It degrades to a collection scan like any
// ordinary index, which is exactly the regression the observe gate exists to
// catch.
const HIDE_BREAKS_QUERIES: readonly IndexDirection[] = ["text", "2dsphere", "2d"];

// Does this index serve queries that cannot run without it? One such key is
// enough — a compound `{tenant: 1, name: "text"}` is still the only thing that
// can answer a $text query on that collection.
export function hideBreaksQueries(index: IndexSpec): boolean {
  return index.keys.some((key) => HIDE_BREAKS_QUERIES.includes(key.direction));
}

// Indexes that must never be auto-dropped regardless of usage, because
// dropping one does something no latency gate can detect:
//
//   _id_      mandatory.
//   unique    enforces a constraint; removing it permits duplicate data, and
//             recreating the index afterwards will not undo them. This also
//             covers unique partial/sparse indexes, the "unique among active
//             documents" pattern.
//   TTL       expires documents; low query usage is the normal state for one.
//   shard key the cluster does not work without it.
//   text/geo  the index IS the access path: hiding one makes $text or $near
//             fail rather than slow down, so the drop cannot be observed at
//             all — see HIDE_BREAKS_QUERIES above.
//
// Partial and sparse indexes are NOT on this list. They used to be, on the
// argument that low usage is expected for a deliberately narrow index — but
// that is a statement about reading counters, and the pipeline does not rely on
// counters alone: it hides, measures, and un-hides on regression. Taxonomy is
// the wrong tool when the safety net is measurement. They still carry the usual
// requirement of a trustworthy history, and a unique one is still protected
// above.
export function isNeverDrop(index: IndexSpec): boolean {
  if (index.name === "_id_") return true;
  if (index.unique) return true;
  if (index.ttl) return true;
  if (index.isShardKey) return true;
  if (hideBreaksQueries(index)) return true;
  return false;
}
