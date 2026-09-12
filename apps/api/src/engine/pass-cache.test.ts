import { describe, expect, it } from "vitest";
import { PassCache, passCached, withPassCache } from "./pass-cache";

describe("PassCache", () => {
  it("takes one reading however many callers want it", async () => {
    const cache = new PassCache();
    let reads = 0;
    const load = async (): Promise<number> => {
      reads += 1;
      return 7;
    };
    const both = await Promise.all([cache.read("k", load), cache.read("k", load)]);
    const later = await cache.read("k", load);
    expect(both).toEqual([7, 7]);
    expect(later).toBe(7);
    expect(reads).toBe(1);
  });

  it("keys readings apart", async () => {
    const cache = new PassCache();
    expect(await cache.read("a", async () => 1)).toBe(1);
    expect(await cache.read("b", async () => 2)).toBe(2);
    expect(cache.size).toBe(2);
  });

  // The one that matters. A cached rejection would answer for the rest of the
  // pass, turning one unreachable moment into a namespace that cannot be read —
  // and the callers are written to survive a throw, not a pass of them.
  it("does not keep a failed read", async () => {
    const cache = new PassCache();
    let reads = 0;
    const flaky = async (): Promise<string> => {
      reads += 1;
      if (reads === 1) throw new Error("unreachable");
      return "ok";
    };
    await expect(cache.read("k", flaky)).rejects.toThrow("unreachable");
    expect(await cache.read("k", flaky)).toBe("ok");
    expect(reads).toBe(2);
  });

  it("shares the reading only inside its own pass", async () => {
    let reads = 0;
    const load = async (): Promise<number> => {
      reads += 1;
      return reads;
    };
    await withPassCache(new PassCache(), async () => {
      await passCached("k", load);
      await passCached("k", load);
    });
    expect(reads).toBe(1);
    await withPassCache(new PassCache(), async () => {
      await passCached("k", load);
    });
    expect(reads).toBe(2);
  });

  // A controller calling a collector directly, and every unit test: no pass, no
  // sharing, every call reads. This is the behaviour that predates the cache and
  // the reason adding one changed no caller.
  it("reads every time outside a pass", async () => {
    let reads = 0;
    const load = async (): Promise<number> => {
      reads += 1;
      return reads;
    };
    expect(await passCached("k", load)).toBe(1);
    expect(await passCached("k", load)).toBe(2);
  });
});
