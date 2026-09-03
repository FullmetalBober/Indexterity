import { describe, expect, it } from "vitest";
import { cooldownDaysFor, proposedVetoDays } from "./cooldown";

// The shape of the curve is the decision (D136), so it is pinned here rather
// than inferred from whatever the writer happened to stamp.
describe("cooldownDaysFor", () => {
  // One observe window, not three. Short enough that a workload which has moved
  // on gets another look soon; not shorter, because the evidence for the drop is
  // a usage history and retrying inside another window re-runs the same
  // experiment against the same workload.
  it("parks a first regression for one observe window", () => {
    expect(cooldownDaysFor(30, 1)).toBe(30);
    expect(cooldownDaysFor(7, 1)).toBe(7);
  });

  // Doubling, where it used to be linear. One regression says this drop was
  // wrong; three say the engine is wrong about this index.
  it("doubles on each repeat, so the third bites harder than linear did", () => {
    expect(cooldownDaysFor(30, 2)).toBe(60);
    expect(cooldownDaysFor(30, 3)).toBe(120);
    expect(cooldownDaysFor(30, 4)).toBe(240);
    // And it is lower than the old linear curve at EVERY step, which is easy to
    // assume otherwise once it doubles: the cap lands before the doubling
    // overtakes 3x·n. The engine retries sooner and never parks for more than a
    // year on its own; what holds a repeat offender down is the score penalty.
    for (const count of [1, 2, 3, 4, 5, 6, 10]) {
      expect(cooldownDaysFor(30, count)).toBeLessThan(3 * 30 * count);
    }
  });

  // Or the eighth regression would park an index for twenty years.
  it("is capped", () => {
    expect(cooldownDaysFor(30, 8)).toBe(365);
    expect(cooldownDaysFor(30, 40)).toBe(365);
  });

  // A count of zero is every manual veto row (jobs/cooldowns.ts writes 0 there),
  // and it must not compute a shorter park than a first regression would.
  it("treats a zero or negative count as the first step", () => {
    expect(cooldownDaysFor(30, 0)).toBe(30);
    expect(cooldownDaysFor(30, -3)).toBe(30);
  });
});

describe("proposedVetoDays", () => {
  // The dialog's default is the engine's own first retry, so the number in the
  // box is the engine's opinion rather than a round one somebody liked. It was a
  // flat 90 that was neither shown nor chosen.
  it("is the engine's first-retry span for the window in force", () => {
    expect(proposedVetoDays(30)).toBe(cooldownDaysFor(30, 1));
    expect(proposedVetoDays(30)).toBe(30);
    expect(proposedVetoDays(90)).toBe(90);
  });
});
