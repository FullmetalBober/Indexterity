// The recurring schedule, as something a tick can evaluate (#212, #231).
//
// Born for burst mode, where graphile-worker's cron could not help — its cron
// only runs inside `run()`, and a `runOnce()` tick would drain the queue and
// never enqueue anything. Since #231 replaced the resident runner with the tick
// and #232 removed the crontab it read, this list IS the schedule: every pass
// the pipeline runs, expressed so any trigger can ask "what became due while
// nobody was running?".
//
// Every entry is its most recent OCCURRENCE at or before `now`, not "has an
// interval elapsed". That distinction is what makes a tick idempotent for free:
// two ticks a minute apart compute the SAME occurrence for a five-minute pass,
// so the second one's claim fails against the first one's watermark and nothing
// is dispatched twice. An elapsed-interval reading would have needed a lock.
//
// It is also what preserves the anchors. `retention` runs at 03:00 and `digest`
// on Monday at 09:00, and an interval reading would have drifted both to
// "whenever you happened to tick first" — a customer-facing weekly email going
// out at 04:12 because that is when the cron service was free.

export interface ScheduledPass {
  // The graphile-worker task to enqueue.
  readonly task: string;
  // The cron entry this stands for, so the two can be read side by side.
  readonly cron: string;
  // The most recent time this was due at or before `now`.
  readonly occurrenceAt: (now: Date) => Date;
}

// Truncate to a whole number of `minutes` past the hour, in UTC.
function everyMinutes(minutes: number) {
  return (now: Date): Date => {
    const at = new Date(now);
    at.setUTCSeconds(0, 0);
    at.setUTCMinutes(Math.floor(at.getUTCMinutes() / minutes) * minutes);
    return at;
  };
}

// The most recent HH:mm today, or yesterday's if that time has not come round.
function dailyAt(hour: number, minute: number) {
  return (now: Date): Date => {
    const at = new Date(now);
    at.setUTCHours(hour, minute, 0, 0);
    if (at > now) at.setUTCDate(at.getUTCDate() - 1);
    return at;
  };
}

// The most recent `weekday` at HH:mm. 1 = Monday, matching cron.
function weeklyAt(weekday: number, hour: number, minute: number) {
  return (now: Date): Date => {
    const at = new Date(now);
    at.setUTCHours(hour, minute, 0, 0);
    const back = (at.getUTCDay() - weekday + 7) % 7;
    at.setUTCDate(at.getUTCDate() - back);
    if (at > now) at.setUTCDate(at.getUTCDate() - 7);
    return at;
  };
}

// The cadences are measured, not picked (#178). Collect/suggest are HOURLY,
// bounded from both sides: the ceiling is the write rate against
// latency_samples — the one table where nothing run-length-collapses (#67
// measured index_snapshots folding 76% of its looks into runs and
// latency_samples folding NONE), so its storage and the dashboard's scan both
// scale linearly with this number. The floor is what a reader can see: four
// points a day is not a trend, and the latency panel reading as broken is what
// prompted hourly. Halving to thirty minutes would double the scan and the
// storage to buy 48 points where 24 already clears the floor six times over —
// the signal that has to be FAST is scheduleProbe's, five minutes below, which
// is how a missing index shows up as latency long before the next hourly pass
// would notice. scheduleApply also runs at five minutes so an approved drop
// hides promptly; finalize is hourly, retention daily at 03:00, and the
// read-only digest mails Monday 09:00.
//
// The two five-minute passes carried offsets in the old resident crontab so
// they would not contend for connections. A tick dispatches them in the same
// moment by construction, so the offset is dropped rather than faked; the
// `cron` field keeps the entry each pass historically stood for, readable side
// by side with the occurrence arithmetic.
export const BURST_SCHEDULE: readonly ScheduledPass[] = [
  { task: "scheduleCollect", cron: "0 * * * *", occurrenceAt: everyMinutes(60) },
  // The `:30` offset keeps two hourly passes off the same cluster in the same
  // minute in a resident worker. A burst tick has one moment to work with, so
  // it is read as "hourly" rather than faked.
  { task: "scheduleSuggest", cron: "30 * * * *", occurrenceAt: everyMinutes(60) },
  { task: "scheduleApply", cron: "*/5 * * * *", occurrenceAt: everyMinutes(5) },
  {
    task: "scheduleProbe",
    cron: "2,7,12,17,22,27,32,37,42,47,52,57 * * * *",
    occurrenceAt: everyMinutes(5),
  },
  { task: "scheduleFinalize", cron: "0 * * * *", occurrenceAt: everyMinutes(60) },
  { task: "retention", cron: "0 3 * * *", occurrenceAt: dailyAt(3, 0) },
  { task: "digest", cron: "0 9 * * 1", occurrenceAt: weeklyAt(1, 9, 0) },
];

// Which passes became due since each was last dispatched.
//
// `lastDispatchedAt` is what the watermark table holds; an absent entry is a
// pass that has never run, and it is due. That makes the FIRST tick of a fresh
// install dispatch everything at once, which is right: nothing has been
// collected, and waiting for the top of the hour to start is a worse first
// impression than a busy minute.
export function duePasses(
  now: Date,
  lastDispatchedAt: ReadonlyMap<string, Date>,
  schedule: readonly ScheduledPass[] = BURST_SCHEDULE,
): { pass: ScheduledPass; occurrence: Date }[] {
  const due: { pass: ScheduledPass; occurrence: Date }[] = [];
  for (const pass of schedule) {
    const occurrence = pass.occurrenceAt(now);
    const last = lastDispatchedAt.get(pass.task);
    if (last === undefined || last < occurrence) due.push({ pass, occurrence });
  }
  return due;
}
