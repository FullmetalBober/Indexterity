// Was the COLLECTION being used, not just the index?
//
// Every usage rule so far measured wall-clock: enough snapshots, spanning
// enough days, without a hole. That is the wrong clock for a database that is
// up continuously but only worked occasionally — a staging or development
// cluster, or a production one with a nightly batch and quiet days.
//
// An index reads zero for two completely different reasons: nobody needs it, or
// nobody queried the collection at all. Wall-clock cannot tell them apart, and
// a month of an idle cluster looks exactly like a month of proof. The
// collection's own read counter can: an interval where the collection served no
// reads carries no information about which of its indexes earned their keep.
//
// So usage findings are judged on ACTIVE intervals — those where the collection
// actually did something — rather than on elapsed time.

export interface ActivityPoint {
  readonly capturedAt: string;
  // Cumulative reads for the collection, as $collStats reports them.
  readonly readOps: number;
}

// Intervals in which the collection served at least one read.
//
// Counters are cumulative since the server started, so an interval's traffic is
// the difference between consecutive samples. A negative difference means the
// counter restarted; that interval is unknowable and is dropped rather than
// counted either way.
export function activeIntervals(points: readonly ActivityPoint[]): number {
  const sorted = [...points]
    .map((point) => ({ time: new Date(point.capturedAt).getTime(), readOps: point.readOps }))
    .filter((point) => Number.isFinite(point.time))
    .sort((a, b) => a.time - b.time);

  let active = 0;
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous === undefined || current === undefined) continue;
    const delta = current.readOps - previous.readOps;
    if (delta > 0) active += 1;
  }
  return active;
}
