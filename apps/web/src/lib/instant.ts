// Turning an instant off the wire into a Date, once.
//
// @repo/contracts now declares every timestamp field `instant` (`z.iso.datetime()`)
// rather than `z.string()`, so the api cannot serve an unreadable one — oRPC
// validates its own output. This is the reader's half of the same rule, and it
// exists because the dashboard had thirteen `new Date(field)` calls and three
// guards between them. What the other ten did with an unparseable value:
//
//   new Date(bad).getTime() > Date.now()        false — a pending drop read as
//                                              not pending
//   (Date.now() - NaN) / 3_600_000 > 48         false — the staleness badge that
//                                              stops old numbers reading as
//                                              current never drew
//   new Date(bad).toLocaleString()              rendered the string "Invalid Date"
//   new Date(bad).toISOString()                 THREW, in the !mounted branch,
//                                              which is server-side render
//
// Every one of those is a wrong answer that looks like an answer, which is the
// failure mode this codebase treats as the expensive one. So there is one parse
// and it returns `Date | null`, and a caller that wants to render something has
// to say what it renders for null.
//
// Takes `unknown` rather than `string`: it also serves the chart axis, which is
// handed whatever the scale is holding — a Date on a tick, a string off a point,
// and a pixel offset when a pointer event lands between them. `new Date(null)` is
// the epoch exactly, so an absent value used to read as a real instant in 1970.

/** A readable instant, or null. Never a Date that answers NaN. */
export function instantOf(at: unknown): Date | null {
  if (at === null || at === undefined) return null;
  // Checked rather than claimed: a Date is used as-is, a string or number is
  // parsed, and anything else was never a timestamp.
  if (at instanceof Date) return Number.isNaN(at.getTime()) ? null : at;
  if (typeof at !== "string" && typeof at !== "number") return null;
  const date = new Date(at);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Milliseconds since the epoch, or null — for the comparisons and the arithmetic. */
export function millisOf(at: unknown): number | null {
  return instantOf(at)?.getTime() ?? null;
}
