// What every per-cluster read hook answers with.
//
// It used to be the bare payload, defaulted to an empty array — a nice API, and
// the reason #72 existed: `isPending` was discarded at the hook boundary, so
// nothing downstream *could* tell "there is nothing here" from "we have not been
// told yet". Both rendered the empty state, and our empty states make claims.
// "Nothing to review means nothing is obviously wrong" was shown about clusters
// with forty proposals still in flight.
//
// Three states collapsed into two is the bug; this is the shape that keeps all
// three. `data` is still always present and still the stable empty fallback, so
// a panel that does not care reads it exactly as before.
export interface Read<T> {
  readonly data: T;
  // The FIRST fetch only — react-query's `isPending`, not `isFetching`. These
  // queries poll and every mutation invalidates them, so gating on `isFetching`
  // would swap a populated table for grey bars on a schedule, which is worse
  // than the bug being fixed. Once a read has answered, it never goes pending
  // again for that key.
  readonly pending: boolean;
}
