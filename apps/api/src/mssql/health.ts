import type { ServerHealth } from "../engine/types";
import { asNumber, type MssqlConnection } from "./connection";

// The ServerHealth port, mapped onto SQL Server (#205).
//
// mongod answers this from one `serverStatus`; SQL Server has no single command
// that says what its query engine is doing, so it comes from two surfaces —
// `sys.dm_os_performance_counters` for the cumulative work counters and
// `sys.dm_os_waiting_tasks` for the instantaneous queue. Both need
// VIEW SERVER STATE and nothing more, which the provisioned scoped login
// already holds (mssql/provision.ts) — verified by reading both DMVs as a login
// granted only that.
//
// Every counter below was measured moving on 2022 CU26 rather than picked off a
// documentation page, because two of the candidates in the issue do not survive
// contact with a live server:
//
//   Sort Warnings/sec   DOES NOT EXIST on Linux SQL Server. No counter matching
//                       '%Sort%' or '%Warning%' is published under any SQLServer:
//                       object. `Workfiles Created/sec` is what stands in.
//   Range Scans/sec     moves for an ordinary singleton seek on a non-unique
//                       index — 500 seeks moved it by exactly 500 — so it is not
//                       a scanning signal at all, and pairing it with a Query
//                       Store aggregate would have measured two windows anyway.
//
// The mapping, and what was measured for each (one-second windows, load running
// continuously):
//
//   collectionScans  Full Scans/sec        30 full scans moved it by exactly 30
//   scannedKeys      Index Searches/sec    3000 seeks moved it by 3019
//   scannedObjects   Page lookups/sec      +9076 over those 3000 seeks, +263611
//                                          over 30 full scans of the same table
//   scanAndOrder     Workfiles Created/sec +3990 for ONE starved 300k-row sort,
//                                          and zero movement across every
//                                          non-spilling seek and scan loop
//   queuedReaders    dm_os_waiting_tasks   0 idle, 3 with three blocked readers
//   queuedWriters    dm_os_waiting_tasks   0 in both
//   residentMb       Total Server Memory   instantaneous, KB
//
// `Page lookups / Index Searches` is the docs-walked-per-index-key analogue, and
// it is a good one: a healthy seeking workload measured 3.01 — which is just the
// b-tree descent, so it does not grow with the table — against 66.6 when full
// scans dominated. That is the same shape-of-the-work reading mongo gets from
// scannedObjects/scanned, from ONE source over ONE window, which was the open
// design question in the issue.
//
// THE SAMPLING GAP IS LOAD-BEARING. Read twice in a tight loop, Index Searches,
// Page lookups and Range Scans return a STALE snapshot while Full Scans moves
// eagerly — a scan workload measured 30 full scans and a flat zero for the other
// three. With a second or more between readings every counter moves exactly.
// The probe samples five seconds apart (jobs/probe.ts), which is well clear, but
// anyone shortening that gap would get silent zeros rather than an error.

// Waits that mean a READER is queued: a shared or intent-shared lock it cannot
// take, or a page it is waiting to have read in. Classified rather than counted,
// because sys.dm_os_waiting_tasks is mostly the server's own background threads
// — 33 of them on an idle container — and COUNT(*) would report a healthy server
// as permanently critical.
const READER_WAITS = `
  wt.wait_type LIKE 'LCK[_]M[_]S%' OR wt.wait_type LIKE 'LCK[_]M[_]IS%'
  OR wt.wait_type IN ('PAGEIOLATCH_SH', 'PAGEIOLATCH_KP')`;

// The same for a writer: an exclusive, update or intent-exclusive lock, a page
// being written, or the log flush.
const WRITER_WAITS = `
  wt.wait_type LIKE 'LCK[_]M[_]X%' OR wt.wait_type LIKE 'LCK[_]M[_]IX%'
  OR wt.wait_type LIKE 'LCK[_]M[_]U%' OR wt.wait_type LIKE 'LCK[_]M[_]SIX%'
  OR wt.wait_type IN ('PAGEIOLATCH_EX', 'PAGEIOLATCH_UP', 'WRITELOG')`;

interface HealthRow {
  readonly fullScans: unknown;
  readonly indexSearches: unknown;
  readonly pageLookups: unknown;
  readonly workfiles: unknown;
  readonly totalMemKb: unknown;
  readonly queuedReaders: unknown;
  readonly queuedWriters: unknown;
}

// Matched on counter_name alone, with the object left out on purpose: a NAMED
// instance publishes these under `MSSQL$<name>:Access Methods` rather than
// `SQLServer:Access Methods`, so filtering on the object name would read every
// counter as zero on exactly the deployments most likely to be a real one. The
// five names are unique across the view, and the empty-instance guard keeps the
// per-database families (SQLServer:Databases) out.
const HEALTH_SQL = `
  SELECT
    MAX(CASE WHEN c.ctr = 'Full Scans/sec'           THEN c.v END) AS fullScans,
    MAX(CASE WHEN c.ctr = 'Index Searches/sec'       THEN c.v END) AS indexSearches,
    MAX(CASE WHEN c.ctr = 'Page lookups/sec'         THEN c.v END) AS pageLookups,
    MAX(CASE WHEN c.ctr = 'Workfiles Created/sec'    THEN c.v END) AS workfiles,
    MAX(CASE WHEN c.ctr = 'Total Server Memory (KB)' THEN c.v END) AS totalMemKb,
    (SELECT COUNT(*) FROM sys.dm_os_waiting_tasks wt WHERE ${READER_WAITS}) AS queuedReaders,
    (SELECT COUNT(*) FROM sys.dm_os_waiting_tasks wt WHERE ${WRITER_WAITS}) AS queuedWriters
  FROM (
    SELECT RTRIM(counter_name) AS ctr, cntr_value AS v
    FROM sys.dm_os_performance_counters
    WHERE RTRIM(counter_name) IN (
      'Full Scans/sec', 'Index Searches/sec', 'Page lookups/sec',
      'Workfiles Created/sec', 'Total Server Memory (KB)')
      AND RTRIM(ISNULL(instance_name, '')) = ''
  ) c`;

// Pure, so the mapping can be tested without a server.
export function toServerHealth(row: HealthRow | undefined): ServerHealth | null {
  if (row === undefined) return null;
  return {
    collectionScans: asNumber(row.fullScans),
    scannedObjects: asNumber(row.pageLookups),
    scannedKeys: asNumber(row.indexSearches),
    scanAndOrder: asNumber(row.workfiles),
    queuedReaders: asNumber(row.queuedReaders),
    queuedWriters: asNumber(row.queuedWriters),
    // The buffer pool and everything else the instance holds, which is what
    // mongo's mem.resident means for mongod. Not the container's RSS: on Linux
    // SQL Server that would include the SQLPAL host, and it is not what any
    // threshold here reads anyway.
    residentMb: Math.round(asNumber(row.totalMemKb) / 1024),
  };
}

// Null when the credentials cannot read the DMVs — the port's "could not read",
// and every other collector call still works. Not an error path: VIEW SERVER
// STATE is a grant an operator may reasonably have withheld.
export async function collectMssqlServerHealth(
  conn: MssqlConnection,
): Promise<ServerHealth | null> {
  try {
    const rows = await conn.query<HealthRow>(HEALTH_SQL);
    return toServerHealth(rows[0]);
  } catch {
    return null;
  }
}
