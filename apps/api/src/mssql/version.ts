// SQL Server version rules, same shape as mongo/version.ts: a hard floor that
// is a support decision, a tested ceiling that is a humility decision, and one
// escape hatch for the ceiling only.
//
// The capability floor is far lower than the support floor — ALTER INDEX …
// DISABLE has existed since 2005 and sys.dm_db_index_usage_stats since 2005 —
// but Query Store, which is the only workload/latency source that survives a
// restart, arrived in 2016 (major 13). Below that the latency gates would rest
// on sys.dm_exec_query_stats, which the plan cache silently evicts, and the
// product would be guessing. 2014 and older are also long past end-of-life.

import { workerEnv } from "../config/env";

export interface MssqlServerVersion {
  readonly major: number;
  readonly minor: number;
  readonly text: string;
}

// ProductVersion majors → marketing names, for messages people can act on.
const PRODUCT_NAMES: Record<number, string> = {
  13: "SQL Server 2016",
  14: "SQL Server 2017",
  15: "SQL Server 2019",
  16: "SQL Server 2022",
  17: "SQL Server 2025",
};

export function mssqlProductName(version: MssqlServerVersion): string {
  return PRODUCT_NAMES[version.major] ?? `SQL Server (engine version ${version.text})`;
}

export const MSSQL_MIN_MAJOR = 13; // 2016
// Probed against live servers — 2022 (16.0, CU24) and 2025 (17.0.4075): the
// DISABLE/REBUILD semantics, the rebuild counter reset (still resets on 17.0),
// restart wipes, Query Store persistence and plan-XML anatomy, and the
// internal-query flag on index builds are identical on both. 2025's new index
// types (VECTOR = 8, JSON = 9) fall outside the rowstore filter and stay
// invisible to the pipeline by design (#209).
export const MSSQL_MAX_TESTED_MAJOR = 17;

export function allowUntestedMssqlVersions(): boolean {
  return workerEnv().ALLOW_UNTESTED_MSSQL_VERSION;
}

// SERVERPROPERTY('ProductVersion') reports "16.0.4250.1". Unreadable is
// unsupported, never "probably fine".
export function parseMssqlVersion(value: unknown): MssqlServerVersion | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\.(\d+)/.exec(value.trim());
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
  return { major, minor, text: value };
}

export function mssqlVersionRefusal(version: MssqlServerVersion | null): string | null {
  if (version === null) {
    return (
      "the server's version could not be read, and an unreadable version is " +
      "treated as unsupported: this engine disables and drops indexes on a live " +
      "database, and it does not guess"
    );
  }
  if (version.major < MSSQL_MIN_MAJOR) {
    return (
      `${mssqlProductName(version)} is older than the SQL Server 2016 floor. ` +
      "Query Store — the only workload signal that survives a restart — does not " +
      "exist there, and releases that old take no security fixes. Upgrade the " +
      "server, or point Indexterity at a 2016+ instance"
    );
  }
  if (version.major > MSSQL_MAX_TESTED_MAJOR && !allowUntestedMssqlVersions()) {
    return (
      `${mssqlProductName(version)} is newer than the SQL Server 2025 series this ` +
      "engine has been tested against. Refusing rather than guessing: DISABLE/REBUILD " +
      "semantics and the usage-stats reset behaviour have moved between releases " +
      "before. Set ALLOW_UNTESTED_MSSQL_VERSION=true to proceed anyway"
    );
  }
  return null;
}
