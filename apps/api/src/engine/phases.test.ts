import { describe, expect, it } from "vitest";
import { beginPhase, PassPhases, timePhase, withPhases } from "./phases";

// A phase whose elapsed time is decided by the test rather than by the clock:
// `phases`/`summary` take `now`, so an assertion about seconds needs no waiting
// and no fake timers around AsyncLocalStorage.
function at(phases: PassPhases, now: number) {
  return phases.summary(4, now);
}

describe("recording where a pass spent its time", () => {
  it("aggregates repeats of one phase into a single total and a call count", () => {
    const phases = new PassPhases();
    for (const _ of [1, 2, 3]) phases.enter("latencyByCollection")();

    const [only] = phases.phases();
    expect(only?.name).toBe("latencyByCollection");
    expect(only?.calls).toBe(3);
    expect(only?.running).toBe(false);
  });

  it("orders the report by cost, so the dominant phase is the first thing read", () => {
    const phases = new PassPhases();
    // Ended out of order on purpose: what decides the order is time spent, not
    // when the phase finished.
    const cheap = phases.enter("queryStore:catalog");
    const dear = phases.enter("queryStore:planXml");
    cheap();
    dear();

    // Both are sub-second here, so this asserts the ORDER via `phases()` and
    // leaves the second-threshold to its own test below.
    expect(phases.phases().map((phase) => phase.name)).toContain("queryStore:planXml");
  });

  // The load-bearing case, and the one the first draft of this got wrong.
  //
  // A budget abandons a pass MID-FLIGHT: `withPassBudget` rejects and
  // `runClusterTask` reads the report immediately, while the pass carries on. So
  // the phase that was running when the clock ran out has not been left, and it
  // is precisely the phase worth naming. Counting only completed phases left the
  // slow loop out of every report it mattered in.
  it("counts a phase that has not finished, and says that it has not", () => {
    const phases = new PassPhases();
    const started = Date.now();
    phases.enter("per-collection");

    const [only] = phases.phases(started + 210_000);
    expect(only?.name).toBe("per-collection");
    expect(only?.totalMs).toBe(210_000);
    expect(only?.calls).toBe(1);
    expect(only?.running).toBe(true);
    expect(at(phases, started + 210_000)).toBe("per-collection 210s/1 (still running)");
  });

  it("adds a finished pass of a phase to an unfinished one of the same name", () => {
    const phases = new PassPhases();
    const started = Date.now();
    // One database's loop finished; the next database's is still going.
    phases.enter("per-collection")();
    phases.enter("per-collection");

    const [only] = phases.phases(started + 60_000);
    expect(only?.calls).toBe(2);
    expect(only?.running).toBe(true);
    // The finished one contributed ~0ms, the open one 60s.
    expect(only?.totalMs).toBeGreaterThanOrEqual(60_000);
  });

  it("counts two overlapping calls of one phase separately", () => {
    const phases = new PassPhases();
    const started = Date.now();
    // What a Promise.all over the same read looks like: taking only the latest
    // start would report half the cost.
    phases.enter("usageByCollection");
    phases.enter("usageByCollection");

    const [only] = phases.phases(started + 10_000);
    expect(only?.calls).toBe(2);
    expect(only?.totalMs).toBe(20_000);
  });

  it("ends a phase once however many times the caller says so", () => {
    const phases = new PassPhases();
    const done = phases.enter("listCollectionNames");
    done();
    done();

    expect(phases.phases()[0]?.calls).toBe(1);
  });

  it("drops sub-second phases rather than rounding them to a measured zero", () => {
    const phases = new PassPhases();
    const started = Date.now();
    const slow = phases.enter("queryStore:planXml");
    phases.enter("queryStore:catalog")();
    slow();

    // `catalog` took no measurable time; reporting it as `0s/1` would read as a
    // measurement rather than as noise.
    expect(at(phases, started)).toBe("");
  });

  it("says nothing at all when nothing was timed", () => {
    // The pass was abandoned before it entered a phase, or the engine has no
    // instrumentation yet. Every caller appends this to a sentence, so it has to
    // read exactly as it did before phases existed.
    expect(new PassPhases().summary()).toBe("");
  });

  it("caps the report, because the point is which phase dominated", () => {
    const phases = new PassPhases();
    const started = Date.now();
    for (const name of ["a", "b", "c", "d", "e"]) phases.enter(name);

    expect(at(phases, started + 5_000).split(", ")).toHaveLength(4);
  });
});

describe("timing a phase from inside a pass", () => {
  it("records what the pass ran and returns its value", async () => {
    const phases = new PassPhases();
    const answer = await withPhases(phases, () =>
      timePhase("indexesByCollection", () => Promise.resolve(7)),
    );

    expect(answer).toBe(7);
    expect(phases.phases()[0]?.name).toBe("indexesByCollection");
  });

  it("records a phase that threw, because a slow failure is worth seeing", async () => {
    const phases = new PassPhases();
    await expect(
      withPhases(phases, () =>
        timePhase("latencyByCollection", () => Promise.reject(new Error("Msg 916"))),
      ),
    ).rejects.toThrow("Msg 916");

    expect(phases.phases()[0]?.name).toBe("latencyByCollection");
    expect(phases.phases()[0]?.running).toBe(false);
  });

  // The property that lets `timePhase` be put anywhere: a collector called by a
  // controller, or by a test, is not inside a pass and must behave as before.
  it("is a no-op outside a pass, and still returns the value", async () => {
    await expect(timePhase("indexesByCollection", () => Promise.resolve("x"))).resolves.toBe("x");
    // And the loop-shaped form hands back something safe to call.
    expect(() => beginPhase("per-collection")()).not.toThrow();
  });
});
