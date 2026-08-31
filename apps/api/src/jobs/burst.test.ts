import { describe, expect, it } from "vitest";
import { claimDuePasses, type PassClaims } from "./burst";
import { BURST_SCHEDULE } from "./schedule";
import { passKey } from "./watermark";

// The whole double, and it is an object with two methods now: the port says
// what a tick asks of the watermark table, so nothing has to be mocked out of
// the module and no query builder has to be faked. The claim rule below IS the
// postgres statement's — claim unless something claimed this key at or after
// `notBefore` — so the cases are about what the tick does with a won or lost
// claim rather than about drizzle.
function passClaims(
  rows: { key: string; at: Date }[] = [],
  claimed = new Map<string, Date>(),
): { claims: PassClaims; claimed: Map<string, Date> } {
  const claims: PassClaims = {
    watermarks: () => Promise.resolve(rows),
    claim: (key, notBefore, now) => {
      const previous = claimed.get(key);
      if (previous !== undefined && previous >= notBefore) return Promise.resolve(false);
      claimed.set(key, now);
      return Promise.resolve(true);
    },
  };
  return { claims, claimed };
}

const NOW = new Date("2026-08-15T10:07:00.000Z");

describe("claimDuePasses", () => {
  it("dispatches everything on a fresh install", async () => {
    const enqueued: string[] = [];
    const result = await claimDuePasses(
      passClaims().claims,
      async (task) => void enqueued.push(task),
      NOW,
    );
    expect(result.dispatched).toEqual(BURST_SCHEDULE.map((pass) => pass.task));
    expect(enqueued).toEqual(result.dispatched);
  });

  // The overlap guard, which is the thing two crons firing close together
  // actually need. The second tick loses every claim and enqueues nothing —
  // not an error, and reported so a tick can say so rather than looking idle.
  it("enqueues nothing on a second tick inside the same buckets", async () => {
    const first: string[] = [];
    const { claimed } = passClaims();
    await claimDuePasses(
      passClaims([], claimed).claims,
      async (task) => void first.push(task),
      NOW,
    );

    const rows = [...claimed.entries()].map(([key, at]) => ({ key, at }));
    const second: string[] = [];
    const result = await claimDuePasses(
      passClaims(rows, claimed).claims,
      async (task) => void second.push(task),
      new Date(NOW.getTime() + 60_000),
    );
    expect(second).toEqual([]);
    expect(result.dispatched).toEqual([]);
    expect(result.alreadyClaimed).toEqual([]);
  });

  // Claim BEFORE enqueue, and the asymmetry is the reason: losing one
  // occurrence of a pass that recurs anyway is cheap, while dispatching twice
  // runs the whole fleet again and spends a real dial budget doing it.
  it("does not enqueue a pass whose claim was lost to another tick", async () => {
    // Another tick got there first, this bucket.
    const claimed = new Map<string, Date>();
    for (const pass of BURST_SCHEDULE) {
      claimed.set(passKey(pass.task), new Date(NOW.getTime() - 1000));
    }
    const enqueued: string[] = [];
    const result = await claimDuePasses(
      passClaims([], claimed).claims,
      async (task) => void enqueued.push(task),
      NOW,
    );
    expect(enqueued).toEqual([]);
    expect(result.alreadyClaimed).toEqual(BURST_SCHEDULE.map((pass) => pass.task));
  });

  it("dispatches only what came due, once a bucket has rolled over", async () => {
    // Everything dispatched five minutes ago: only the five-minute passes are
    // due again.
    const justNow = new Date(NOW.getTime() - 5 * 60_000);
    const rows = BURST_SCHEDULE.map((pass) => ({ key: passKey(pass.task), at: justNow }));
    const claimed = new Map(rows.map((row) => [row.key, row.at]));
    const enqueued: string[] = [];
    await claimDuePasses(
      passClaims(rows, claimed).claims,
      async (task) => void enqueued.push(task),
      NOW,
    );
    expect(enqueued).toEqual(["scheduleApply", "scheduleProbe"]);
  });
});
