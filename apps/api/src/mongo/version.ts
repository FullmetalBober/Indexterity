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
