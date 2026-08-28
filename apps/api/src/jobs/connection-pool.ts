import type { ClusterEngine, DialProxy, EngineSession, TlsOverrides } from "../engine/ports";
import { adapterFor } from "../engine/registry";

// One engine session per cluster, shared across jobs and requests — drivers
// pool sockets inside a session, so the win is skipping a fresh client + TLS
// handshake on every job. Entries are refcounted; idle unreferenced entries are
// swept, and a changed connection string dooms the old entry (closed once free).

interface PoolEntry {
  connString: string;
  session: EngineSession;
  refs: number;
  lastUsed: number;
  doomed: boolean;
}

export interface PooledSession {
  readonly session: EngineSession;
  readonly release: () => void;
}

const IDLE_MS = 5 * 60_000;
const SWEEP_MS = 60_000;

const entries = new Map<string, Promise<PoolEntry>>();
let sweeper: NodeJS.Timeout | null = null;

function ensureSweeper(): void {
  if (sweeper !== null) return;
  sweeper = setInterval(() => {
    void sweepIdle();
  }, SWEEP_MS);
  // Never hold the process open just for the pool.
  sweeper.unref();
}

async function sweepIdle(): Promise<void> {
  const now = Date.now();
  for (const [key, pending] of entries) {
    const entry = await pending.catch(() => null);
    if (entry === null) continue;
    if (entry.refs === 0 && (entry.doomed || now - entry.lastUsed >= IDLE_MS)) {
      entries.delete(key);
      await entry.session.close().catch(() => {});
    }
  }
}

async function createEntry(
  engine: ClusterEngine,
  connString: string,
  overrides?: TlsOverrides,
  proxy?: DialProxy,
): Promise<PoolEntry> {
  const session = await adapterFor(engine).open(connString, overrides, proxy);
  return { connString, session, refs: 0, lastUsed: Date.now(), doomed: false };
}

export async function acquireClusterSession(
  clusterId: string,
  engine: ClusterEngine,
  connString: string,
  // The cluster row's recorded consent. Not cached as part of the entry key:
  // it only ever changes alongside the string it was chosen for, which already
  // dooms the entry below.
  overrides?: TlsOverrides,
  // Where the dial is routed when the cluster sits behind a tunnel. Not part
  // of the entry key: a tunnel's SOCKS port is stable for the life of the
  // tunnel, and a tunnel that is replaced closes its listener, which fails the
  // pooled session and dooms the entry the same way a rotated string does.
  proxy?: DialProxy,
): Promise<PooledSession> {
  ensureSweeper();
  let pending = entries.get(clusterId);
  if (pending !== undefined) {
    const current = await pending.catch(() => null);
    if (current === null) {
      // Previous connect failed — retry fresh.
      entries.delete(clusterId);
      pending = undefined;
    } else if (current.connString !== connString) {
      // Credentials rotated: doom the old entry (closed once released) and dial new.
      current.doomed = true;
      if (current.refs === 0) {
        entries.delete(clusterId);
        await current.session.close().catch(() => {});
      }
      pending = undefined;
    }
  }
  if (pending === undefined) {
    pending = createEntry(engine, connString, overrides, proxy);
    entries.set(clusterId, pending);
    pending.catch(() => entries.delete(clusterId));
  }
  const entry = await pending;
  entry.refs += 1;
  entry.lastUsed = Date.now();
  let released = false;
  return {
    session: entry.session,
    release: () => {
      if (released) return;
      released = true;
      entry.refs -= 1;
      entry.lastUsed = Date.now();
      if (entry.doomed && entry.refs === 0) {
        void entry.session.close().catch(() => {});
      }
    },
  };
}

// Introspection for tests/diagnostics.
export async function poolStats(): Promise<Array<{ clusterId: string; refs: number }>> {
  const out: Array<{ clusterId: string; refs: number }> = [];
  for (const [clusterId, pending] of entries) {
    const entry = await pending.catch(() => null);
    if (entry !== null) out.push({ clusterId, refs: entry.refs });
  }
  return out;
}

// Drop one cluster's entry now (offboarding): close if free, doom otherwise.
export async function evictCluster(clusterId: string): Promise<void> {
  const pending = entries.get(clusterId);
  if (pending === undefined) return;
  const entry = await pending.catch(() => null);
  if (entry === null) {
    entries.delete(clusterId);
    return;
  }
  entry.doomed = true;
  if (entry.refs === 0) {
    entries.delete(clusterId);
    await entry.session.close().catch(() => {});
  }
}

// Close everything now (tests / graceful shutdown).
export async function drainPool(): Promise<void> {
  const all = [...entries.values()];
  entries.clear();
  for (const pending of all) {
    const entry = await pending.catch(() => null);
    if (entry !== null) await entry.session.close().catch(() => {});
  }
}
