import { z } from "zod";

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
