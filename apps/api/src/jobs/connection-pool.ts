import { MongoConnection } from "../mongo";

// One MongoClient per cluster, shared across jobs and requests — the driver
// pools sockets inside a client, so the win is skipping a fresh client + TLS
// handshake on every job. Entries are refcounted; idle unreferenced entries are
// swept, and a changed connection string dooms the old entry (closed once free).

interface PoolEntry {
  connString: string;
  conn: MongoConnection;
  refs: number;
  lastUsed: number;
  doomed: boolean;
}

export interface PooledConnection {
  readonly conn: MongoConnection;
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
      await entry.conn.close().catch(() => {});
    }
  }
}

async function createEntry(connString: string): Promise<PoolEntry> {
  const conn = new MongoConnection(connString);
  await conn.connect();
  return { connString, conn, refs: 0, lastUsed: Date.now(), doomed: false };
}

export async function acquireClusterConnection(
  clusterId: string,
  connString: string,
): Promise<PooledConnection> {
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
        await current.conn.close().catch(() => {});
      }
      pending = undefined;
    }
  }
  if (pending === undefined) {
    pending = createEntry(connString);
    entries.set(clusterId, pending);
    pending.catch(() => entries.delete(clusterId));
  }
  const entry = await pending;
  entry.refs += 1;
  entry.lastUsed = Date.now();
  let released = false;
  return {
    conn: entry.conn,
    release: () => {
      if (released) return;
      released = true;
      entry.refs -= 1;
      entry.lastUsed = Date.now();
      if (entry.doomed && entry.refs === 0) {
        void entry.conn.close().catch(() => {});
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
    await entry.conn.close().catch(() => {});
  }
}

// Close everything now (tests / graceful shutdown).
export async function drainPool(): Promise<void> {
  const all = [...entries.values()];
  entries.clear();
  for (const pending of all) {
    const entry = await pending.catch(() => null);
    if (entry !== null) await entry.conn.close().catch(() => {});
  }
}
