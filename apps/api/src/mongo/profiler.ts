import { z } from "zod";
import type { FailedOpsReading } from "../engine/ports";

// What `profile: -1` answers for one database. The level and the filter are the
// database's own; `slowms` and `sampleRate` are server-wide and only reported
// here (probed on mongod 6.0 to 9.0: a filter set on one database leaves another
// at `was: 0` with none).
export const profilerSettings = z.object({
  was: z.coerce.number(),
  slowms: z.coerce.number(),
  sampleRate: z.coerce.number().optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
});
export type ProfilerSettings = z.infer<typeof profilerSettings>;

// What a profiler set up like this does NOT record, as a clause the audit line
// can carry after "but" — or null when it records every operation.
//
// Read off the settings because the ring alone cannot tell. Every case below was
// measured on mongod 6.0 to 9.0 with a hint at a hidden index, which fails in
// 0 ms:
//   - level 2 records it, and overrides sampleRate as well as slowms: 50 of 50
//     failures kept at a sampleRate of 0.01.
//   - level 1 with no filter records operations slower than `slowms`, so not it —
//     unless slowms is 0, where 10 of 10 were kept.
//   - level 1 with a filter records what the filter selects, and replaces
//     `slowms` outright — what that filter keeps is the customer's to say.
//   - level 0 records nothing new; only what is still in the ring from before.
export function profilerBlindSpot(
  database: string,
  settings: ProfilerSettings | null,
): string | null {
  if (settings === null) {
    return `the profiler's settings on ${database} could not be read, so it may keep only slow operations`;
  }
  if (settings.was >= 2) return null;
  if (settings.was <= 0) return `the profiler on ${database} has since been turned off`;
  if (settings.filter !== undefined) {
    return `the profiler on ${database} keeps only what its filter selects`;
  }
  const rate = settings.sampleRate ?? 1;
  if (settings.slowms <= 0 && rate >= 1) return null;
  const which = rate >= 1 ? "operations" : `a ${Math.round(rate * 100)}% sample of operations`;
  return `the profiler on ${database} keeps only ${which} slower than ${settings.slowms} ms, and a failed one is fast`;
}

// What one database's ring and settings add up to for the failed-operations
// check (#596). Pure over what the collector read, so every case is a unit test.
export function failedOpsReading(read: {
  readonly database: string;
  // Failures on the namespace since the instant asked, counted on the server.
  readonly failed: number;
  // The ring's oldest entry, any namespace — its reach — or null when it is empty.
  readonly oldest: Date | null;
  readonly settings: ProfilerSettings | null;
  readonly throughMongos: boolean;
}): FailedOpsReading {
  const { database, failed, oldest, settings } = read;
  // Through mongos the ring read is the database's PRIMARY SHARD's — mongos routes
  // it there — but `profile: -1` answers for mongos itself, which never profiles.
  // Probed on 7.0 with the shard at level 2: mongos said `was: 0`, and the same
  // read returned the shard's failure. So the settings are unknowable from here
  // rather than off, and saying "off" would be wrong.
  if (read.throughMongos) {
    return oldest === null
      ? {
          kind: "NO_SOURCE",
          reason: `${database}'s primary shard has profiled nothing, and mongos cannot say whether its profiler is on`,
        }
      : {
          kind: "WINDOW",
          failed,
          reachMs: oldest.getTime(),
          blindSpot: `only ${database}'s primary shard is read, and mongos cannot say how its profiler is set`,
        };
  }
  // Off, and nothing from when it was on says otherwise. Failures recorded before
  // somebody turned it off are still failures, so those still count.
  if (settings?.was === 0 && failed === 0) {
    return { kind: "NO_SOURCE", reason: `the profiler is off on ${database}` };
  }
  if (oldest === null) {
    return { kind: "NO_SOURCE", reason: `the profiler on ${database} has recorded nothing yet` };
  }
  return {
    kind: "WINDOW",
    failed,
    reachMs: oldest.getTime(),
    blindSpot: profilerBlindSpot(database, settings),
  };
}
