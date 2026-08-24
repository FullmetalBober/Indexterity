import { workerEnv } from "../config/env";

// The server-version gate, in the part of it that is the same on every engine.
//
// Each adapter owns its own floor, ceiling and wording — those are capability
// and support decisions per engine (mongo/version.ts, postgres/version.ts,
// mssql/version.ts). What every one of them shares is the ceiling's escape
// hatch and the refusal they all raise, both of which lived in mongo/ until
// #329 because MongoDB's module is where the shared piece happened to be first.

// The server cannot do what the pipeline requires. Distinct from a network
// failure and from a permission failure: retrying will never fix it, so the
// jobs treat it as a condition to report rather than an error to retry.
export class UnsupportedServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedServerError";
  }
}

// Blocking every customer on a brand-new release until we ship is its own kind
// of failure, so the ceiling is overridable — same shape as the other
// self-hosted escape hatches. The floor is not overridable: below it the
// pipeline is either impossible or unsupported on purpose.
//
// ALLOW_UNTESTED_DATABASE_VERSION has no engine in its name and one reader for
// all three.
export function allowUntestedVersions(): boolean {
  return workerEnv().ALLOW_UNTESTED_DATABASE_VERSION;
}
