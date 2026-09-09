import { describe, expect, it } from "vitest";
import { type ChaseIntervals, chaseKey, chaseNotBefore } from "./classify-cadence";

const NOW = new Date("2026-09-09T12:00:00.000Z");
const INTERVALS: ChaseIntervals = { minIntervalMs: 21_600_000, idleIntervalMs: 86_400_000 };
const HOUR = 3_600_000;

// The whole of the cadence policy, and the reason it is a pure function: the
// claim it feeds is a compare-and-set, so this Date IS the decision. Getting it
// wrong in one direction re-derives a verdict about weeks every hour, and in the
// other leaves a cluster's recommendations frozen.
describe("chaseNotBefore", () => {
  it("asks for the short interval when the collect learned something", () => {
    expect(chaseNotBefore(NOW, true, INTERVALS)).toEqual(new Date(NOW.getTime() - 6 * HOUR));
  });

  it("asks for the long one when it learned nothing", () => {
    expect(chaseNotBefore(NOW, false, INTERVALS)).toEqual(new Date(NOW.getTime() - 24 * HOUR));
  });

  // An idle interval below the floor would invert the rule the two numbers
  // exist to state — a cluster whose counters never move classifying MORE often
  // than one that changes every hour. The schema documents the constraint; the
  // function does not depend on the operator having read it.
  it("never lets an idle cluster be due sooner than a busy one", () => {
    const inverted: ChaseIntervals = { minIntervalMs: 21_600_000, idleIntervalMs: HOUR };
    expect(chaseNotBefore(NOW, false, inverted)).toEqual(chaseNotBefore(NOW, true, inverted));
  });

  // Zero is not a value the schema accepts (positiveInteger), but "chase every
  // collect" is the behaviour this replaced, and it should still be reachable by
  // configuration rather than only by reverting the change.
  it("degrades to chasing every collect at a one-millisecond floor", () => {
    const eager: ChaseIntervals = { minIntervalMs: 1, idleIntervalMs: 1 };
    expect(chaseNotBefore(NOW, true, eager).getTime()).toBe(NOW.getTime() - 1);
  });
});

// Its own namespace, keyed per cluster. The tick's `pass:` keys are one per
// scheduled pass for the whole deployment; a collision would make one cluster's
// chase stand down a deployment-wide schedule, or the reverse.
describe("chaseKey", () => {
  it("namespaces the chase away from the tick's own claims", () => {
    expect(chaseKey("classify", "abc")).toBe("chase:classify:abc");
    expect(chaseKey("classify", "abc")).not.toContain("pass:");
  });

  it("gives each cluster its own claim", () => {
    expect(chaseKey("classify", "a")).not.toBe(chaseKey("classify", "b"));
  });
});
