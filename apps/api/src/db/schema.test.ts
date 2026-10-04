import { describe, expect, it } from "vitest";
import { LIVE_STATES, recommendationState, SETTLED_STATES } from "./schema";

// The dashboard lists a recommendation either as open or as history, by these two
// lists. A state in neither would vanish from both tables; a state in both would
// be drawn twice.
describe("recommendation states", () => {
  it("are each live or settled, and never both", () => {
    const live = new Set<string>(LIVE_STATES);
    const settled = new Set<string>(SETTLED_STATES);
    expect([...live].filter((state) => settled.has(state))).toEqual([]);
    expect(new Set([...live, ...settled])).toEqual(new Set(recommendationState.enumValues));
  });
});
