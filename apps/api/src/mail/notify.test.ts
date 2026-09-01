import { describe, expect, it } from "vitest";
import {
  ALERT_COOLDOWN_MS,
  type AlertClaims,
  alertAllowed,
  alertSettled,
  type ClaimStore,
  raiseAlert,
} from "./notify";

// The compare-and-set the watermark table performs, in memory: claim the key
// unless something claimed it at or after `notBefore`. Asserting against this
// rather than against a stubbed drizzle chain keeps the case about the RULE;
// that postgres implements the rule atomically is what the integration suite
// covers.
function memoryStore(): AlertClaims {
  const claimed = new Map<string, Date>();
  return {
    claim: (key, notBefore, now) => {
      const previous = claimed.get(key);
      if (previous !== undefined && previous >= notBefore) return Promise.resolve(false);
      claimed.set(key, now);
      return Promise.resolve(true);
    },
    // The unconditional backward re-stamp deferWatermark performs.
    defer: (key, at) => {
      claimed.set(key, at);
      return Promise.resolve();
    },
  };
}

function memoryClaims(): ClaimStore {
  return memoryStore().claim;
}

const hour = 3_600_000;
const t0 = new Date("2026-08-15T00:00:00.000Z");
// Not named `after`: biome reads a call to that as a test hook.
const hoursOn = (hours: number): Date => new Date(t0.getTime() + hours * hour);

describe("alert cooldown", () => {
  it("allows the first alert per key, then suppresses within the window", async () => {
    const claim = memoryClaims();
    const allowed = (key: string, at: Date) => alertAllowed(claim, key, ALERT_COOLDOWN_MS, at);

    expect(await allowed("cluster-a:collect", t0)).toBe(true);
    // Six hours later the next collect fails again — same cluster, same task.
    expect(await allowed("cluster-a:collect", hoursOn(6))).toBe(false);
    expect(await allowed("cluster-a:collect", hoursOn(18))).toBe(false);
    // A different cluster is not suppressed by a noisy neighbour.
    expect(await allowed("cluster-b:collect", hoursOn(1))).toBe(true);
    // Past the window it alerts again — a still-broken cluster is worth a
    // daily reminder.
    expect(await allowed("cluster-a:collect", hoursOn(25))).toBe(true);
  });

  // The reason this moved out of memory at all (#212). A burst tick is a whole
  // process, so an in-memory Map starts empty every time: on a fifteen-minute
  // cron a cluster unreachable since Tuesday would mail its owners 96 times a
  // day. The store surviving the process is the entire fix, and this is what it
  // has to mean.
  it("suppresses across processes, which is what a per-tick worker needs", async () => {
    const shared = memoryClaims();
    // Two ticks, each a fresh process, sharing only the store.
    expect(await alertAllowed(shared, "cluster-a:collect", ALERT_COOLDOWN_MS, t0)).toBe(true);
    expect(
      await alertAllowed(
        shared,
        "cluster-a:collect",
        ALERT_COOLDOWN_MS,
        new Date(t0.getTime() + 15 * 60_000),
      ),
    ).toBe(false);
  });
});

// #419. The claim is taken BEFORE the send, which is what keeps two racing ticks
// down to one mail — and what made an SMTP fault cost a whole day of silence,
// because the claim was spent on a mail that never left the process.
describe("a send that fails", () => {
  const send = (settled: boolean) => () => Promise.resolve(settled);
  const minutes = (count: number) => new Date(t0.getTime() + count * 60_000);

  it("hands most of the window back, so the next occurrence alerts again", async () => {
    const store = memoryStore();
    const sent: string[] = [];
    const failing = () => {
      sent.push("attempt");
      return Promise.resolve(false);
    };

    await raiseAlert(store, "cluster-a:collect", failing, { now: t0 });
    expect(sent).toHaveLength(1);

    // Still inside the retry window: a tick a minute later must not re-mail, or
    // a transport that is down turns one alert into one per tick.
    await raiseAlert(store, "cluster-a:collect", failing, { now: minutes(1) });
    expect(sent).toHaveLength(1);

    // Past it, the alert is tried again — minutes, not the 24 hours the burned
    // claim used to cost.
    await raiseAlert(store, "cluster-a:collect", failing, { now: minutes(6) });
    expect(sent).toHaveLength(2);
  });

  it("keeps the full cooldown when the send settled", async () => {
    const store = memoryStore();
    const sent: string[] = [];
    const delivering = () => {
      sent.push("attempt");
      return Promise.resolve(true);
    };

    await raiseAlert(store, "cluster-a:collect", delivering, { now: t0 });
    // An hour later, and six hours later, the owners hear nothing more: this is
    // the noise suppression the cooldown exists for, and a settled send must not
    // lose it to the retry path.
    for (const at of [minutes(6), hoursOn(1), hoursOn(6)]) {
      await raiseAlert(store, "cluster-a:collect", delivering, { now: at });
    }
    expect(sent).toHaveLength(1);
    // And the day still ends the window.
    await raiseAlert(store, "cluster-a:collect", delivering, { now: hoursOn(25) });
    expect(sent).toHaveLength(2);
  });

  it("defers only its own key", async () => {
    const store = memoryStore();
    await raiseAlert(store, "cluster-a:collect", send(false), { now: t0 });
    await raiseAlert(store, "cluster-b:collect", send(true), { now: t0 });

    const sent: string[] = [];
    const record = (key: string) => () => {
      sent.push(key);
      return Promise.resolve(true);
    };
    for (const key of ["cluster-a:collect", "cluster-b:collect"]) {
      await raiseAlert(store, key, record(key), { now: minutes(6) });
    }
    // The failed one is retried; the delivered one is still inside its day.
    expect(sent).toEqual(["cluster-a:collect"]);
  });

  it("still lets exactly one of two racing ticks send", async () => {
    // The property the claim-first ordering exists for, and the one a release
    // would have given up: both ticks are inside the same moment, so the loser
    // must not send even though the winner's send is still in flight.
    const store = memoryStore();
    const sent: string[] = [];
    const slow = () =>
      new Promise<boolean>((resolve) => {
        sent.push("attempt");
        setTimeout(() => resolve(false), 0);
      });
    await Promise.all([
      raiseAlert(store, "cluster-a:collect", slow, { now: t0 }),
      raiseAlert(store, "cluster-a:collect", slow, { now: t0 }),
    ]);
    expect(sent).toHaveLength(1);
  });
});

// The polarity of the boolean raiseAlert reads. Three of the four cases are
// settled with nothing delivered, and getting any of them backwards is either a
// lost alert or a mail every five minutes forever.
describe("alertSettled", () => {
  it("is settled when the transport took at least one, even partially", () => {
    expect(alertSettled(1, 1, true)).toBe(true);
    expect(alertSettled(3, 1, true)).toBe(true);
  });

  it("is settled when there was nobody to mail", () => {
    expect(alertSettled(0, 0, true)).toBe(true);
  });

  it("is settled with no transport configured, which is every dev deployment", () => {
    expect(alertSettled(2, 0, false)).toBe(true);
  });

  it("is unsettled only when a configured transport refused every send", () => {
    expect(alertSettled(2, 0, true)).toBe(false);
  });
});
