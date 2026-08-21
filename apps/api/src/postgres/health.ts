import type { ServerHealth } from "../analysis";
import type { PostgresConnection } from "./connection";

// The server-wide query-engine counters behind the health probe.
//
// The port's vocabulary is MongoDB's `serverStatus`, and three of its seven
// fields have an exact PostgreSQL twin, two have an honest approximation, and one
// has nothing. Each mapping is named below rather than left for a reader to
// reverse-engineer, because a health verdict built on a field that means
// something else is worse than no verdict.
//
// Returns null when the credentials cannot read these views at all — the
// privilege is optional and everything else still works. `pg_monitor` grants it,
// and the provisioned role has it.
export async function collectPostgresHealth(
  conn: PostgresConnection,
): Promise<ServerHealth | null> {
  try {
    const rows = await conn.query<{
      seq_scans: string | number | null;
      seq_rows: string | number | null;
      idx_rows: string | number | null;
      temp_files: string | number | null;
      lock_waits: string | number | null;
      write_waits: string | number | null;
      buffers_mb: string | number | null;
    }>(
      // One statement, because these are three unrelated views and three round
      // trips to read seven numbers is three chances for them to disagree about
      // when "now" was.
      `SELECT (SELECT COALESCE(sum(seq_scan), 0)      FROM pg_stat_user_tables) AS seq_scans,
              (SELECT COALESCE(sum(seq_tup_read), 0)  FROM pg_stat_user_tables) AS seq_rows,
              (SELECT COALESCE(sum(idx_tup_fetch), 0) FROM pg_stat_user_tables) AS idx_rows,
              (SELECT COALESCE(temp_files, 0) FROM pg_stat_database
                WHERE datname = current_database())                             AS temp_files,
              (SELECT count(*) FROM pg_stat_activity
                WHERE wait_event_type = 'Lock'
                  AND query ~* '^\\s*(SELECT|WITH|TABLE)\\M')                   AS lock_waits,
              (SELECT count(*) FROM pg_stat_activity
                WHERE wait_event_type = 'Lock'
                  AND query !~* '^\\s*(SELECT|WITH|TABLE)\\M')                  AS write_waits,
              (SELECT setting::bigint * 8192 / 1048576 FROM pg_settings
                WHERE name = 'shared_buffers')                                  AS buffers_mb`,
    );
    const row = rows[0];
    if (row === undefined) return null;
    return {
      // Sequential scans across every user table — the direct twin of
      // MongoDB's collection scans, and the number an index can actually move.
      collectionScans: Number(row.seq_scans ?? 0),
      // Rows those sequential scans walked. `seq_tup_read` is exactly "documents
      // examined by a scan".
      scannedObjects: Number(row.seq_rows ?? 0),
      // Rows fetched THROUGH an index. `idx_tup_fetch` rather than
      // `idx_tup_read`: the former counts live rows handed to the query, the
      // latter counts index entries visited including dead ones, and the ratio
      // the health verdict computes is documents-per-key.
      scannedKeys: Number(row.idx_rows ?? 0),
      // APPROXIMATION, and the weakest of the seven. MongoDB's `scanAndOrder`
      // counts plans that sorted without an index; Postgres has no such counter,
      // so this is `temp_files` — files written for on-disk sorts and hashes.
      // A sort that fits in `work_mem` never appears, so this UNDERSTATES the
      // problem and never overstates it, which is the right direction for a
      // number that raises an alarm.
      scanAndOrder: Number(row.temp_files ?? 0),
      // Sessions blocked on a lock, split by whether the statement reads or
      // writes — the same split MongoDB's global-lock queues report. Matched on
      // the leading keyword, the same rule collector.ts uses for latency, and
      // approximate for the same reason.
      queuedReaders: Number(row.lock_waits ?? 0),
      queuedWriters: Number(row.write_waits ?? 0),
      // NOT resident memory. Postgres does not report its own RSS, and nothing
      // in a statistics view does either — so this is `shared_buffers`, the
      // cache size the server was configured with. Reported because the health
      // verdict uses it for scale (is the working set plausibly cached), and
      // named here so nobody reads it as live memory pressure.
      residentMb: Number(row.buffers_mb ?? 0),
    };
  } catch {
    // The privilege is optional by design: a cluster whose credentials cannot
    // read these views is analysed without a health verdict rather than refused.
    return null;
  }
}
