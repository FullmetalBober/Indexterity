import { describe, expect, it } from "vitest";
import { LIVE_STATES, recommendationState, SETTLED_STATES } from "./schema";

// The open recommendations list is LIVE_STATES. A state in neither list would
// vanish from it with nobody having decided that; a state in both would be open
// and settled at once.
describe("recommendation states", () => {
  it("are each live or settled, and never both", () => {
    const live = new Set<string>(LIVE_STATES);
    const settled = new Set<string>(SETTLED_STATES);
    expect([...live].filter((state) => settled.has(state))).toEqual([]);
    expect(new Set([...live, ...settled])).toEqual(new Set(recommendationState.enumValues));
  });
});
