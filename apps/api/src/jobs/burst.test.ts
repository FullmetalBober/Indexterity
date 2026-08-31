import { describe, expect, it, vi } from "vitest";
import { claimDuePasses } from "./burst";
import { BURST_SCHEDULE } from "./schedule";
import { passKey } from "./watermark";

vi.mock("./watermark", async (importOriginal) => {
  const original = await importOriginal<typeof import("./watermark")>();
  // The wrapper stays — the factory is hoisted, so naming `claimSpy` eagerly
  // fails — but its parameters are declared rather than spread as `unknown[]`
  // and unpacked with an assertion on the other side.
  return {
    ...original,
    claimWatermark: (db: unknown, key: string, notBefore: Date, now: Date) =>
      claimSpy(db, key, notBefore, now),
  };
});

// Stands in for the conditional upsert: claim unless something claimed this key
// at or after `notBefore`. That IS the postgres statement's rule, so the cases
// below are about what the tick does with a won or lost claim rather than about
// drizzle.
let claimed = new Map<string, Date>();
// Parameters declared rather than unpacked out of `unknown[]` and asserted:
// the shape was always known, it just was not written down.
const claimSpy = (_db: unknown, key: string, notBefore: Date, now: Date): Promise<boolean> => {
  const previous = claimed.get(key);
  if (previous !== undefined && previous >= notBefore) return Promise.resolve(false);
  claimed.set(key, now);
  return Promise.resolve(true);
};

// The tick reads the watermark rows first; `rows` is what that read returns.
function fakeDb(rows: { key: string; at: Date }[]) {
  return {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
  } as never;
}

const NOW = new Date("2026-08-15T10:07:00.000Z");

describe("claimDuePasses", () => {
  it("dispatches everything on a fresh install", async () => {
    claimed = new Map();
    const enqueued: string[] = [];
    const result = await claimDuePasses(fakeDb([]), async (task) => void enqueued.push(task), NOW);
    expect(result.dispatched).toEqual(BURST_SCHEDULE.map((pass) => pass.task));
    expect(enqueued).toEqual(result.dispatched);
  });

  // The overlap guard, which is the thing two crons firing close together
  // actually need. The second tick loses every claim and enqueues nothing —
  // not an error, and reported so a tick can say so rather than looking idle.
  it("enqueues nothing on a second tick inside the same buckets", async () => {
    claimed = new Map();
    const first: string[] = [];
    await claimDuePasses(fakeDb([]), async (task) => void first.push(task), NOW);

    const rows = [...claimed.entries()].map(([key, at]) => ({ key, at }));
    const second: string[] = [];
    const result = await claimDuePasses(
      fakeDb(rows),
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
    claimed = new Map();
    // Another tick got there first, this bucket.
    for (const pass of BURST_SCHEDULE) {
      claimed.set(passKey(pass.task), new Date(NOW.getTime() - 1000));
    }
    const enqueued: string[] = [];
    const result = await claimDuePasses(fakeDb([]), async (task) => void enqueued.push(task), NOW);
    expect(enqueued).toEqual([]);
    expect(result.alreadyClaimed).toEqual(BURST_SCHEDULE.map((pass) => pass.task));
  });

  it("dispatches only what came due, once a bucket has rolled over", async () => {
    claimed = new Map();
    // Everything dispatched five minutes ago: only the five-minute passes are
    // due again.
    const justNow = new Date(NOW.getTime() - 5 * 60_000);
    const rows = BURST_SCHEDULE.map((pass) => ({ key: passKey(pass.task), at: justNow }));
    for (const row of rows) claimed.set(row.key, row.at);
    const enqueued: string[] = [];
    await claimDuePasses(fakeDb(rows), async (task) => void enqueued.push(task), NOW);
    expect(enqueued).toEqual(["scheduleApply", "scheduleProbe"]);
  });
});
