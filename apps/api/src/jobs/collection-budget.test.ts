import { describe, expect, it } from "vitest";
import { collectionIndexesAfterBuild } from "./collection-budget";

// `pendingBuildsByCollection` needs a database and is exercised by the
// integration suite; this is the arithmetic, which is the part that fails
// silently. Getting the "+ 1" wrong shifts every crowding penalty by one step
// and nothing anywhere throws.
describe("collectionIndexesAfterBuild", () => {
  it("counts what exists, what is coming, and this build", () => {
    expect(collectionIndexesAfterBuild(3, 0)).toBe(4);
    expect(collectionIndexesAfterBuild(3, 2)).toBe(6);
  });

  // The whole reason pending is counted at all: an APPROVED create waits for the
  // change window, which can be most of a day, and its index does not exist yet —
  // so without this, five builds approved across five passes each look like the
  // first one.
  it("does not let a build in flight read as an empty collection", () => {
    expect(collectionIndexesAfterBuild(0, 4)).toBeGreaterThan(collectionIndexesAfterBuild(0, 0));
  });

  it("is never zero — a build is always at least its own index", () => {
    expect(collectionIndexesAfterBuild(0, 0)).toBe(1);
  });
});
