import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDatabase, eq, workerWatermarks } from "../src/db";
import { chaseKey, classifyChaseIsDue } from "../src/jobs/classify-cadence";
import { alertClaims, alertKey, claimWatermark, deferWatermark } from "../src/jobs/watermark";
import { ALERT_COOLDOWN_MS, ALERT_RETRY_MS, raiseAlert } from "../src/mail/notify";
import { databaseUrl } from "./helpers";

// The claim table's two writes, against a real postgres.
//
// Both are one statement with a conflict clause, and the difference between them
// is the WHERE: the claim refuses to move a stamp that is not old enough, and the
// defer must move one BACKWARD past exactly that guard (#419). A unit test can
// assert the rule; only postgres can say whether these two upserts do what their
// comments claim, and a `deferWatermark` that silently no-ops on conflict would
// pass every unit test in the repo while losing every alert whose mail failed.
//
// No api and no mongo: this drives the functions the worker calls.

let db: ReturnType<typeof createDatabase>;
const keys: string[] = [];

// A key per test, so a re-run against a database that already has rows — which
// is what CI's migrated postgres is by the second suite — starts from nothing.
function freshKey(name: string): string {
  const key = `int:${name}:${process.pid}:${keys.length}`;
  keys.push(key, alertKey(key));
  return key;
}

async function stampOf(key: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: workerWatermarks.at })
    .from(workerWatermarks)
    .where(eq(workerWatermarks.key, key));
  return row?.at ?? null;
}

beforeAll(() => {
  db = createDatabase(databaseUrl(), 2);
});

afterAll(async () => {
  for (const key of keys) {
    await db.delete(workerWatermarks).where(eq(workerWatermarks.key, key));
  }
  await db.$client.end();
});

const t0 = new Date("2026-09-01T12:00:00.000Z");
const at = (ms: number): Date => new Date(t0.getTime() + ms);

describe("claimWatermark", () => {
  it("is a compare-and-set: the second claim inside the window loses", async () => {
    const key = freshKey("claim");
    // notBefore an hour back, so an absent row is claimable and a fresh stamp is
    // not — the shape every caller uses.
    expect(await claimWatermark(db, key, at(-3_600_000), t0)).toBe(true);
    expect(await stampOf(key)).toEqual(t0);
    expect(await claimWatermark(db, key, at(-3_600_000 + 60_000), at(60_000))).toBe(false);
    // The loser wrote nothing, which is what makes the loss safe.
    expect(await stampOf(key)).toEqual(t0);
  });
});

// The classify chase, over the same store (#482, #483). Its rule is not
// expressible as one interval — which threshold applies depends on whether the
// collect that triggered it learned anything — and the two halves interlock in a
// way only a real compare-and-set can show: a busy cluster refused inside the
// floor, an idle one refused for longer, and neither starved.
describe("classifyChaseIsDue", () => {
  const intervals = { minIntervalMs: 6 * 3_600_000, idleIntervalMs: 24 * 3_600_000 };

  it("classifies a cluster's first collect immediately", async () => {
    const cluster = freshKey("chase-first");
    keys.push(chaseKey("classify", cluster));
    // No stamp at all is due, whether or not anything was learned: a cluster
    // connected a minute ago has to say something before six hours are up.
    expect(await classifyChaseIsDue(db, cluster, false, intervals, t0)).toBe(true);
  });

  it("holds a busy cluster to the floor, then lets it through", async () => {
    const cluster = freshKey("chase-busy");
    keys.push(chaseKey("classify", cluster));
    expect(await classifyChaseIsDue(db, cluster, true, intervals, t0)).toBe(true);
    // The next five hourly collects all learned something and all stand down.
    for (const hour of [1, 2, 3, 4, 5]) {
      expect(await classifyChaseIsDue(db, cluster, true, intervals, at(hour * 3_600_000))).toBe(
        false,
      );
    }
    expect(await classifyChaseIsDue(db, cluster, true, intervals, at(7 * 3_600_000))).toBe(true);
  });

  it("waits longer for a cluster that learned nothing, and still gets there", async () => {
    const cluster = freshKey("chase-idle");
    keys.push(chaseKey("classify", cluster));
    expect(await classifyChaseIsDue(db, cluster, false, intervals, t0)).toBe(true);
    // Past the busy floor and still not due, which is the whole of #483: there
    // is no new evidence, so there is nothing to re-derive.
    expect(await classifyChaseIsDue(db, cluster, false, intervals, at(7 * 3_600_000))).toBe(false);
    // But it is not skipped forever. An extended run still moves lastSeenAt and
    // bumps observations, which is how an index idle since we first saw it
    // crosses the three-day span and the seventy-two active hours — a cluster
    // never classified until its counters moved would never make that crossing.
    expect(await classifyChaseIsDue(db, cluster, false, intervals, at(25 * 3_600_000))).toBe(true);
  });

  // The interlock the two thresholds have to have, and the one a single number
  // would get wrong. Evidence lands inside the floor and is refused; nothing
  // lands afterwards. The reading is against the last CLASSIFY, not the last
  // collect, so that evidence is still unclassified and the idle ceiling picks
  // it up rather than it waiting for the next change that may never come.
  it("does not strand evidence that landed inside the floor", async () => {
    const cluster = freshKey("chase-stranded");
    keys.push(chaseKey("classify", cluster));
    expect(await classifyChaseIsDue(db, cluster, true, intervals, t0)).toBe(true);
    expect(await classifyChaseIsDue(db, cluster, true, intervals, at(2 * 3_600_000))).toBe(false);
    for (const hour of [3, 4, 5]) {
      expect(await classifyChaseIsDue(db, cluster, false, intervals, at(hour * 3_600_000))).toBe(
        false,
      );
    }
    expect(await classifyChaseIsDue(db, cluster, false, intervals, at(25 * 3_600_000))).toBe(true);
  });

  it("gives each cluster its own claim", async () => {
    const one = freshKey("chase-one");
    const two = freshKey("chase-two");
    keys.push(chaseKey("classify", one), chaseKey("classify", two));
    expect(await classifyChaseIsDue(db, one, true, intervals, t0)).toBe(true);
    // One cluster's claim must not stand another one down.
    expect(await classifyChaseIsDue(db, two, true, intervals, t0)).toBe(true);
  });
});

describe("deferWatermark", () => {
  it("moves an existing stamp backward, past the guard a claim would apply", async () => {
    const key = freshKey("defer");
    expect(await claimWatermark(db, key, at(-3_600_000), t0)).toBe(true);
    const deferred = at(-ALERT_COOLDOWN_MS + ALERT_RETRY_MS);
    await deferWatermark(db, key, deferred);
    expect(await stampOf(key)).toEqual(deferred);
  });

  it("inserts when the key has never been claimed", async () => {
    const key = freshKey("defer-insert");
    await deferWatermark(db, key, t0);
    expect(await stampOf(key)).toEqual(t0);
  });
});

// What #419 buys, end to end on the store the worker actually uses: a mail that
// reached nothing costs minutes of silence rather than a day of it.
describe("a failed alert send", () => {
  it("is retried in minutes, and not before them", async () => {
    const key = freshKey("alert");
    const claims = alertClaims(db);
    const sent: Date[] = [];
    const failing = (now: Date) => () => {
      sent.push(now);
      return Promise.resolve(false);
    };

    await raiseAlert(claims, key, failing(t0), { now: t0 });
    expect(sent).toHaveLength(1);
    // The claim is still held — a second tick a minute later must not re-mail.
    await raiseAlert(claims, key, failing(at(60_000)), { now: at(60_000) });
    expect(sent).toHaveLength(1);
    // Past the retry window the same failure alerts again.
    const later = at(ALERT_RETRY_MS + 1000);
    await raiseAlert(claims, key, failing(later), { now: later });
    expect(sent).toHaveLength(2);
  });

  it("leaves a delivered alert holding the full day", async () => {
    const key = freshKey("alert-delivered");
    const claims = alertClaims(db);
    const sent: Date[] = [];
    const delivering = (now: Date) => () => {
      sent.push(now);
      return Promise.resolve(true);
    };

    await raiseAlert(claims, key, delivering(t0), { now: t0 });
    const later = at(ALERT_RETRY_MS + 1000);
    await raiseAlert(claims, key, delivering(later), { now: later });
    expect(sent).toHaveLength(1);
    // And the stamp is the moment of the send, not a deferred one.
    expect(await stampOf(alertKey(key))).toEqual(t0);
  });
});
