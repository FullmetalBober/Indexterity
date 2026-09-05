import { describe, expect, it } from "vitest";
import { InFlight, trackInFlight, withInFlight } from "./inflight";

describe("InFlight", () => {
  it("cancels what is still registered and forgets it", () => {
    const inFlight = new InFlight();
    const cancelled: string[] = [];
    inFlight.track(() => cancelled.push("a"));
    const untrackB = inFlight.track(() => cancelled.push("b"));
    untrackB();
    expect(inFlight.abandon()).toBe(1);
    expect(cancelled).toEqual(["a"]);
    expect(inFlight.size).toBe(0);
    expect(inFlight.abandon()).toBe(0);
  });

  // Each cancel is best-effort: the statement may have finished between the
  // decision and the call, and a driver that objects must not shield the rest.
  it("keeps cancelling past one that throws", () => {
    const inFlight = new InFlight();
    const cancelled: string[] = [];
    inFlight.track(() => {
      throw new Error("already gone");
    });
    inFlight.track(() => cancelled.push("b"));
    expect(inFlight.abandon()).toBe(2);
    expect(cancelled).toEqual(["b"]);
  });
});

describe("trackInFlight", () => {
  // The whole point of the AsyncLocalStorage: a statement issued deep inside a
  // pass, after several awaits, still lands in that pass's registry.
  it("reaches the pass that is running, across awaits", async () => {
    const inFlight = new InFlight();
    const cancelled: string[] = [];
    await withInFlight(inFlight, async () => {
      await Promise.resolve();
      const untrack = trackInFlight(() => cancelled.push("statement"));
      await Promise.resolve();
      expect(inFlight.size).toBe(1);
      // Settled statements un-register themselves; only the ones still running
      // when the pass is abandoned are cancelled.
      untrack();
      trackInFlight(() => cancelled.push("still running"));
    });
    expect(inFlight.abandon()).toBe(1);
    expect(cancelled).toEqual(["still running"]);
  });

  it("is a no-op outside a pass", () => {
    const untrack = trackInFlight(() => {
      throw new Error("must never be called");
    });
    expect(untrack()).toBeUndefined();
  });

  it("keeps two passes apart", async () => {
    const first = new InFlight();
    const second = new InFlight();
    await Promise.all([
      withInFlight(first, async () => {
        await Promise.resolve();
        trackInFlight(() => undefined);
      }),
      withInFlight(second, async () => {
        trackInFlight(() => undefined);
        trackInFlight(() => undefined);
      }),
    ]);
    expect(first.size).toBe(1);
    expect(second.size).toBe(2);
  });
});
