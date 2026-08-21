// PostgreSQL version rules, same shape as mongo/version.ts and
// mssql/version.ts: a hard floor that is a support decision, a tested ceiling
// that is a humility decision, and one escape hatch for the ceiling only.
//
// The floor here is a LIFECYCLE decision rather than a capability one, and that
// is a real difference from SQL Server, where the floor sits at 2016 because
// Query Store — the only workload signal that survives a restart — does not
// exist below it. Nothing this pipeline needs is missing on 14: idx_scan,
// pg_stat_statements, CREATE/DROP INDEX CONCURRENTLY and INCLUDE columns all
// predate it. So the floor is simply the oldest release still taking security
// fixes, and the one genuinely newer signal degrades instead of refusing —
// see PG_LAST_IDX_SCAN_MAJOR.

export interface PostgresServerVersion {
  readonly major: number;
  readonly minor: number;
  // `server_version` verbatim, which on a packaged build carries the packaging
  // too ("16.15 (Debian 16.15-1.pgdg13+2)"). Kept whole for messages: the
  // distribution is often the thing that explains an oddity.
  readonly text: string;
}

// 13 reached end of life in November 2025 and takes no further security fixes.
export const PG_MIN_MAJOR = 14;

// Probed against live servers — 17.11 and 18.6 (#35). Identical on both: the
// planner ignores an index whose `indisvalid` is cleared while DML keeps
// maintaining it, REINDEX silently restores it, `pg_dump -s` omits it, a crash
// discards every cumulative counter and NULLs `stats_reset` while a clean restart
// preserves them, and 18 adds no per-index planner control that would change any
// of the above.
export const PG_MAX_TESTED_MAJOR = 18;

// `pg_stat_all_indexes.last_idx_scan` — "when was this index last used", without
// having to infer it from the deltas between snapshots. Measured absent on 14.24
// and present on 16.15, so it is enrichment and not a requirement: below 16 the
// classify step falls back to the same snapshot-delta inference it already uses
// on MongoDB and SQL Server, which is why a 14 or 15 server is supported rather
// than refused for wanting it.
export const PG_LAST_IDX_SCAN_MAJOR = 16;

export function postgresHasLastIdxScan(version: PostgresServerVersion): boolean {
  return version.major >= PG_LAST_IDX_SCAN_MAJOR;
}

export function postgresProductName(version: PostgresServerVersion): string {
  return `PostgreSQL ${version.major}`;
}

// Read from `server_version_num` by preference — an integer like 160015, which
// needs no parsing and cannot be confused by a packaging suffix — falling back to
// the `server_version` text. Unreadable is unsupported, never "probably fine":
// this engine drops indexes on a live database and the drop is the one step it
// cannot take back on this engine at all.
export function parsePostgresVersion(
  versionNum: unknown,
  versionText: unknown,
): PostgresServerVersion | null {
  const text = typeof versionText === "string" ? versionText.trim() : "";
  const num = Number(typeof versionNum === "string" ? versionNum.trim() : versionNum);
  if (Number.isInteger(num) && num >= 100000) {
    // 160015 → 16.15. The pre-10 encoding (90624 = 9.6.24) is deliberately not
    // decoded: every such release is a decade past end of life and would be
    // refused by the floor anyway, so reading it would only produce a
    // confidently wrong major.
    return {
      major: Math.floor(num / 10000),
      minor: num % 10000,
      text: text.length > 0 ? text : String(num),
    };
  }
  const match = /^(\d+)\.(\d+)/.exec(text);
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
  return { major, minor, text };
}

export function postgresVersionRefusal(
  version: PostgresServerVersion | null,
  allowUntested = false,
): string | null {
  if (version === null) {
    return (
      "the server's version could not be read, and an unreadable version is " +
      "treated as unsupported: this engine drops indexes on a live database, " +
      "and it does not guess"
    );
  }
  if (version.major < PG_MIN_MAJOR) {
    return (
      `${postgresProductName(version)} is older than the PostgreSQL ${PG_MIN_MAJOR} floor. ` +
      "Releases that old take no security fixes, and this engine connects with " +
      "credentials you gave it. Upgrade the server, or point Indexterity at a " +
      `${PG_MIN_MAJOR}+ instance`
    );
  }
  if (version.major > PG_MAX_TESTED_MAJOR && !allowUntested) {
    return (
      `${postgresProductName(version)} is newer than the PostgreSQL ${PG_MAX_TESTED_MAJOR} ` +
      "series this engine has been tested against. Refusing rather than guessing: " +
      "index visibility and the statistics-reset behaviour have both moved between " +
      "releases before, and on this engine a drop cannot be un-hidden — only rebuilt. " +
      "Set ALLOW_UNTESTED_POSTGRES_VERSION=true to proceed anyway"
    );
  }
  return null;
}
