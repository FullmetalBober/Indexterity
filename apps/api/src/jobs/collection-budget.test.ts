import { describe, expect, it } from "vitest";
import { collectionIndexesAfterBuild, wouldBuildUnattended } from "./collection-budget";

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

// The predicate the budget's report is counted against (#281). It was five
// conditions inline in suggest.ts, combined wrongly, and the first real reading
// was `{"budget": 24}` on a READ-ONLY cluster — where the budget had decided
// nothing and read-only had decided everything.
describe("wouldBuildUnattended", () => {
  const build = (overrides: Partial<Parameters<typeof wouldBuildUnattended>[0]> = {}) => ({
    type: "CREATE",
    scanning: true,
    severity: "CRITICAL",
    count: 9,
    minCount: 5,
    instantCreateEnabled: true,
    readOnly: false,
    ...overrides,
  });

  it("is true for the case instant builds exist for", () => {
    expect(wouldBuildUnattended(build())).toBe(true);
  });

  // The one that shipped wrong. Nothing is executed against a read-only cluster,
  // so the budget cannot be what held a build back there.
  it("is false on a read-only cluster, whatever else is true", () => {
    expect(wouldBuildUnattended(build({ readOnly: true }))).toBe(false);
  });

  it("is false when the owner has not opted in", () => {
    expect(wouldBuildUnattended(build({ instantCreateEnabled: false }))).toBe(false);
  });

  // A routine scan is not urgent enough to act on unasked, and an in-memory sort
  // is not a strong enough argument at all.
  it("is false for a routine scan or a sort-only candidate", () => {
    expect(wouldBuildUnattended(build({ severity: "ROUTINE" }))).toBe(false);
    expect(wouldBuildUnattended(build({ scanning: false }))).toBe(false);
  });

  it("is false below the sightings floor, and true at it", () => {
    expect(wouldBuildUnattended(build({ count: 4 }))).toBe(false);
    expect(wouldBuildUnattended(build({ count: 5 }))).toBe(true);
  });

  // Only a plain CREATE. The others retire something or touch a protected index,
  // and are approval-only however strong the argument.
  it("is false for anything that is not a plain CREATE", () => {
    for (const type of ["UPDATE", "MERGE", "REORDER"]) {
      expect(wouldBuildUnattended(build({ type })), type).toBe(false);
    }
  });
});
