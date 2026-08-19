// The observe selection's one ambiguous case, in one place (#244).
//
// Both adapters' diagnose have to answer the same question — "which databases is
// this verdict about?" — and both have to answer it the same way, or a SQL Server
// and a MongoDB cluster with the same stale selection would report different
// privileges for the same reason.
import type { EngineSession } from "./ports";

// Which databases a DIAGNOSIS is about: the selection, intersected with what the
// cluster actually reports.
//
// The interesting case is an intersection that comes out empty, which happens
// when every selected database has been dropped or renamed. Evaluating over
// nothing would report a role with no privileges anywhere — mongo's anyDb
// requirements need at least one database to be covered by, so an empty scope
// fails all of them — and "your credentials are missing listIndexes" is the wrong
// sentence for "the databases you picked are gone". Falling back to the whole
// cluster is pessimistic in the other direction and says something true: this is
// what the credentials can do, on the databases that are there.
//
// NOT the rule the collect uses. jobs/cluster-connection.ts intersects strictly,
// with no fallback, because there the empty case means "walk nothing" — falling
// back to every database would be the one outcome the selection exists to
// prevent. A diagnosis reports; a collect reads.
export function scopeForDiagnosis(
  available: readonly string[],
  observed: readonly string[] | null | undefined,
): string[] {
  if (observed == null) return [...available];
  const scoped = available.filter((name) => observed.includes(name));
  return scoped.length > 0 ? scoped : [...available];
}

// Every database the cluster reports that this selection leaves out. For the
// count the settings screen draws, and for nothing else — a selection is never
// stored as its complement.
export function unobservedDatabases(
  available: readonly string[],
  observed: readonly string[] | null | undefined,
): string[] {
  if (observed == null) return [];
  return available.filter((name) => !observed.includes(name));
}

// A session that reports only the databases in the selection.
//
// Wrapping one method rather than filtering at the call sites that walk databases
// (mongo/snapshots.ts, jobs/suggest.ts): every job reaches a cluster through
// openClusterSession, so a filter here cannot be forgotten by the next caller that
// needs a database list, and a filter applied by convention at each call site is
// one that eventually is not.
//
// It must not go any deeper either. connection-pool.ts keys entries by clusterId
// and reuses one session across jobs for up to IDLE_MS, dooming it only when the
// connection string changes — so a filter built into the pooled session would keep
// enforcing whichever selection was current when it was dialled. This is
// constructed fresh from the cluster row on every lease, so a change takes effect
// on the next job rather than on the next reconnect.
//
// Delegation is explicit rather than a Proxy: EngineSession is four members, and a
// Proxy would silently forward a fifth one added later — which is exactly the case
// this class exists to catch.
export class ObservedSession implements EngineSession {
  constructor(
    private readonly inner: EngineSession,
    private readonly observed: readonly string[],
  ) {}

  get collector(): EngineSession["collector"] {
    return this.inner.collector;
  }

  executor(readOnly: boolean): ReturnType<EngineSession["executor"]> {
    return this.inner.executor(readOnly);
  }

  // Strict intersection, in the cluster's own order, with no fallback — see
  // scopeForDiagnosis above for why the diagnosis rule differs. A selected
  // database that no longer exists drops out silently: a drop or a rename is a
  // fact about the cluster rather than an error to raise on every collect, and if
  // it comes back the next collect picks it up without the owner re-ticking it.
  async listDatabaseNames(): Promise<string[]> {
    const names = await this.inner.listDatabaseNames();
    return names.filter((name) => this.observed.includes(name));
  }

  ping(): Promise<void> {
    return this.inner.ping();
  }

  // Deliberately delegated: the session is POOLED and shared, so closing is the
  // pool's business either way. Callers release, they do not close.
  close(): Promise<void> {
    return this.inner.close();
  }
}
