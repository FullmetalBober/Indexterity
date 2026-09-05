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
//
// #289 found a FOURTH, by the same argument and with the same symptom. A read
// that failed also fell back to the empty payload, so a 500 from
// `/recommendations` drew "No recommendations yet — nothing to review means
// nothing is obviously wrong" over a cluster with fifty-one live proposals.
// Absent and broken are not the same claim: one is about the cluster and the
// other is about us, and only one of them is reassuring.
export interface Read<T> {
  readonly data: T;
  // The FIRST fetch only — react-query's `isPending`, not `isFetching`. These
  // queries poll and every mutation invalidates them, so gating on `isFetching`
  // would swap a populated table for grey bars on a schedule, which is worse
  // than the bug being fixed. Once a read has answered, it never goes pending
  // again for that key.
  readonly pending: boolean;
  // The read failed and its retries are spent. `data` is the empty fallback and
  // means NOTHING here — a panel that draws it is making a claim it cannot
  // support, which is the whole of #289.
  //
  // Deliberately not true while a refetch of already-good data is failing:
  // react-query keeps the last successful payload, and replacing a populated
  // table with an error because the poll behind it missed once would be its own
  // false claim in the other direction. What this marks is having nothing AND
  // knowing why.
  readonly failed: boolean;
  // Ask again, for the button the failure state offers. A read the reader can
  // retry is the difference between a panel that reports a problem and one that
  // is a dead end.
  readonly retry: () => void;
}

// A PAGED read (#445), which has a fifth state the four above do not: the reader
// asked for a different page — or order, or filter — and the answer is not back.
//
// The key carries the whole request (#455), so each page is its own entry and
// the new one starts with nothing. Left at that, every click and every keystroke
// would make the read `pending` and swap the table for skeleton rows — and the
// table disables its search box while pending, so a reader could type one
// character before the box greyed out under their fingers. So the paged hooks
// keep the previous page on screen as placeholder data while the next is out
// (react-query's `keepPreviousData`), `pending` stays what it means above, and
// THIS says that what `data` holds is the page before the one asked for. The
// control draws the requested page while it is true, since the served offset in
// `data` is the previous request's, and the table dims rather than outlines.
export interface PagedRead<T> extends Read<T> {
  readonly placeholder: boolean;
}
