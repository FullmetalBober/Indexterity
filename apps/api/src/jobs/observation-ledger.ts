import {
  OWN_OUTAGE_MS,
  type OwnOutage,
  outagesBetween,
  ownOutageMs,
  span,
  utcMinute,
} from "../analysis";
import { actions, and, asc, type Database, inArray, like, observationRuns, sql } from "../db";

// The control plane's own record of when it was running (#653): see
// db/schema.ts, observationRuns.

// Extends the current stretch, or opens a new one past an outage. One statement,
// so two replicas ticking together extend the same row or race to open one —
// either leaves a stretch that says we were running, which is all it records.
export async function recordObservation(db: Database, now: Date): Promise<void> {
  await db.execute(sql`
    with latest as (
      select id, last_seen_at from ${observationRuns} order by last_seen_at desc limit 1
    ),
    extended as (
      update ${observationRuns} o
      set last_seen_at = greatest(o.last_seen_at, ${now}::timestamptz)
      from latest
      where o.id = latest.id
        and ${now}::timestamptz - latest.last_seen_at <= ${`${OWN_OUTAGE_MS} milliseconds`}::interval
      returning o.id
    )
    insert into ${observationRuns} (since, last_seen_at)
    select ${now}::timestamptz, ${now}::timestamptz
    where not exists (select 1 from extended)
  `);
}

// Every outage of ours on record. Read whole: the table holds one row per outage
// and one for now.
export async function ownOutages(db: Database): Promise<OwnOutage[]> {
  const rows = await db
    .select({ since: observationRuns.since, lastSeenAt: observationRuns.lastSeenAt })
    .from(observationRuns)
    .orderBy(asc(observationRuns.since));
  return outagesBetween(
    rows.map((row) => ({ sinceMs: row.since.getTime(), lastSeenMs: row.lastSeenAt.getTime() })),
  );
}

// Says in each hidden drop's trail which outages of ours fell inside its observe
// window, once per outage (#653). The window does not count that stretch and the
// deadline moves out by it; without the line, a drop that hid for 33 days instead
// of 30 would have no account of why.
export async function noteOwnOutages(
  db: Database,
  hidden: readonly { readonly id: string; readonly hiddenAt: Date | null }[],
  outages: readonly OwnOutage[],
  nowMs: number,
): Promise<void> {
  const touched = hidden.flatMap((rec) => {
    if (rec.hiddenAt === null) return [];
    const from = rec.hiddenAt.getTime();
    const overlapping = outages.filter((outage) => outage.toMs > from && outage.fromMs < nowMs);
    return overlapping.length === 0 ? [] : [{ id: rec.id, from, overlapping }];
  });
  if (touched.length === 0) return;
  const said = await db
    .select({ id: actions.recommendationId, result: actions.result })
    .from(actions)
    .where(
      and(
        inArray(
          actions.recommendationId,
          touched.map((entry) => entry.id),
        ),
        like(actions.result, `${NOT_WATCHED}%`),
      ),
    );
  for (const { id, from, overlapping } of touched) {
    for (const outage of overlapping) {
      const line = notWatchedLine(outage, ownOutageMs([outage], from, outage.toMs));
      if (said.some((row) => row.id === id && row.result === line)) continue;
      await db
        .insert(actions)
        .values({ recommendationId: id, kind: "HIDE", actor: "system", result: line });
    }
  }
}

const NOT_WATCHED = "not watched:";

// `chargedMs` is the part of the outage inside the drop's window, which is what
// the deadline moves out by.
export function notWatchedLine(outage: OwnOutage, chargedMs: number): string {
  return (
    `${NOT_WATCHED} Indexterity itself was not running from ${utcMinute(outage.fromMs)} to ` +
    `${utcMinute(outage.toMs)}, so that stretch is not counted as observation, and the ` +
    `observe window moves out by ${span(chargedMs)}`
  );
}
