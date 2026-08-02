// Server-version rules.
//
// The floor is 4.4, and it is set by one feature: `collMod {index: {hidden}}`.
// The whole drop path is hide → observe → measure → drop, and on 4.3 and older
// `collMod` does not know the `hidden` option — it reads the request as a TTL
// change and fails with "no expireAfterSeconds field" (verified against 4.2.24).
//
// Left unchecked, that is the worst kind of failure: onboarding reports the
// cluster ready, analysis runs, recommendations are produced and approved, and
// then every apply tick fails with a message about a field nobody mentioned.
// Nothing drops and nothing explains why.

export interface ServerVersion {
  readonly major: number;
  readonly minor: number;
  readonly text: string;
}

export const MIN_MAJOR = 4;
export const MIN_MINOR = 4;
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

// Blocking every customer on a brand-new release until we ship is its own kind
// of failure, so the ceiling is overridable — same shape as the other
// self-hosted escape hatches. The floor is not overridable: below it the
// pipeline provably cannot run.
export function allowUntestedVersions(): boolean {
  return process.env.ALLOW_UNTESTED_MONGO_VERSION === "true";
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
    `ALLOW_UNTESTED_MONGO_VERSION=true to proceed anyway.`
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

// Can this server hide an index? Everything the drop path depends on.
export function supportsHiddenIndexes(version: ServerVersion | null): boolean {
  if (version === null) return false;
  if (version.major > MIN_MAJOR) return true;
  return version.major === MIN_MAJOR && version.minor >= MIN_MINOR;
}

export function unsupportedVersionMessage(version: ServerVersion | null): string {
  const found = version === null ? "an unreadable version" : `MongoDB ${version.text}`;
  return (
    `${found} cannot hide indexes (needs ${MIN_VERSION_TEXT} or newer). ` +
    `Indexterity drops an index only after hiding it and measuring the effect, so ` +
    `without that the safety pipeline cannot run. Analysis and index creation still work.`
  );
}

// The single verdict both the connect-time check and the pre-write guard ask
// for. Returns null when the server is fine, or the reason it is not.
export function versionRefusal(version: ServerVersion | null): string | null {
  if (!supportsHiddenIndexes(version)) return unsupportedVersionMessage(version);
  if (!isTestedVersion(version) && !allowUntestedVersions()) {
    return untestedVersionMessage(version);
  }
  return null;
}
