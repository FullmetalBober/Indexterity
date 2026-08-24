// Server-version rules.
//
// The floor is 6.0, and unlike the ceiling it is a support decision rather than
// a capability one. The capability floor is 4.4: `collMod {index: {hidden}}`,
// which the whole drop path rests on, and which 4.3 and older read as a TTL
// change — it fails with "no expireAfterSeconds field" (verified on 4.2.24).
//
// Everything from 4.4 up can technically run the pipeline. 4.4 (EOL February
// 2024) and 5.0 (EOL October 2024) are refused anyway: they take no security
// fixes, they have no `$queryStats`, and every version-conditional branch they
// need is one more path to keep correct on an engine that drops indexes on
// production databases. Supporting them well costs more than they are worth.
//
// Left unchecked, an unsupported server is the worst kind of failure:
// onboarding reports the cluster ready, analysis runs, recommendations are
// produced and approved, and then every apply tick fails with a message about
// a field nobody mentioned. Nothing drops and nothing explains why.

import { allowUntestedVersions } from "../engine/version";

export interface ServerVersion {
  readonly major: number;
  readonly minor: number;
  readonly text: string;
}

export const MIN_MAJOR = 6;
export const MIN_MINOR = 0;
export const MIN_VERSION_TEXT = `${MIN_MAJOR}.${MIN_MINOR}`;

// The newest major series the engine has actually been exercised against.
// Raise it deliberately, after testing, not because a release happened.
//
// A too-new server is a different risk from a too-old one. Too old cannot do
// the work and never will. Too new probably works — but "probably" is the wrong
// footing for something that drops indexes on a production database, and a
// major release is exactly when command semantics and stat shapes move.
export const MAX_MAJOR = 8;
export const MAX_VERSION_TEXT = `${MAX_MAJOR}.x`;

// `$queryStats` exists from 6.0, but until 8.0 its per-shape metrics are
// execution counts and timings only — no `keysExamined`, `docsExamined` or
// `hasSortStage` (verified absent on 6.0.28 and 7.0.39, present on 8.2.9).
//
// That is the difference between knowing a query ran and knowing it scanned, so
// on 6.0 and 7.0 the store cannot drive a single create recommendation and the
// profiler is the only workload source that can. Callers use this to say so.
export const QUERY_STATS_PLAN_METRICS_MAJOR = 8;

export function hasQueryStatsPlanMetrics(version: ServerVersion | null): boolean {
  if (version === null) return false;
  return version.major >= QUERY_STATS_PLAN_METRICS_MAJOR;
}

export function isTestedVersion(version: ServerVersion | null): boolean {
  if (version === null) return false;
  return version.major <= MAX_MAJOR;
}

export function untestedVersionMessage(version: ServerVersion | null): string {
  const found = version === null ? "an unreadable version" : `MongoDB ${version.text}`;
  return (
    `${found} is newer than the ${MAX_VERSION_TEXT} series Indexterity has been tested against. ` +
    `Refusing rather than guessing: this engine hides, drops and builds indexes on a live ` +
    `database, and a major release is where command behaviour moves. Set ` +
    `ALLOW_UNTESTED_DATABASE_VERSION=true to proceed anyway.`
  );
}

// buildInfo reports `version` ("6.0.28") and `versionArray`. Parse defensively:
// an unreadable version is treated as unsupported rather than assumed modern.
export function parseServerVersion(value: unknown): ServerVersion | null {
  if (typeof value !== "string") return null;
  const match = /^(\d+)\.(\d+)/.exec(value.trim());
  const major = Number(match?.[1]);
  const minor = Number(match?.[2]);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
  return { major, minor, text: value };
}

// Is this server new enough to be supported at all?
export function meetsVersionFloor(version: ServerVersion | null): boolean {
  if (version === null) return false;
  if (version.major > MIN_MAJOR) return true;
  return version.major === MIN_MAJOR && version.minor >= MIN_MINOR;
}

export function unsupportedVersionMessage(version: ServerVersion | null): string {
  const found = version === null ? "an unreadable version" : `MongoDB ${version.text}`;
  return (
    `${found} is older than the ${MIN_VERSION_TEXT} Indexterity supports. ` +
    `Releases before ${MIN_VERSION_TEXT} are past end-of-life and take no security fixes, ` +
    `and they cannot report the query workload the create side reads. Upgrade the server, ` +
    `or run the analysis against a ${MIN_VERSION_TEXT}+ replica.`
  );
}

// The single verdict both the connect-time check and the pre-write guard ask
// for. Returns null when the server is fine, or the reason it is not.
export function versionRefusal(version: ServerVersion | null): string | null {
  if (!meetsVersionFloor(version)) return unsupportedVersionMessage(version);
  if (!isTestedVersion(version) && !allowUntestedVersions()) {
    return untestedVersionMessage(version);
  }
  return null;
}
