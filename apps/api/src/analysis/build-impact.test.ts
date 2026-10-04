import { describe, expect, it } from "vitest";
import { SCANS_SETTLE_MS, type SeenShape, scansFor } from "./build-impact";

const builtAt = new Date("2026-09-04T03:00:00Z");
const HOUR = 3_600_000;

const build = {
  database: "app",
  collection: "settings",
  builtAt,
  servedShapeDigests: ["a", "b"],
  baselineWeeklyDocsExamined: 18_900_000,
};

function seen(digest: string, hoursAfterBuild: number, weekly: number | null = 1000): SeenShape {
  return {
    database: "app",
    collection: "settings",
    digest,
    weeklyDocsExamined: weekly,
    lastSeenAt: new Date(builtAt.getTime() + hoursAfterBuild * HOUR),
  };
}

const settled = new Date(builtAt.getTime() + SCANS_SETTLE_MS + HOUR);

describe("scansFor", () => {
  it("has nothing to say about a build no shape was recorded for", () => {
    expect(scansFor({ ...build, servedShapeDigests: null }, [], settled)).toBeNull();
    expect(scansFor({ ...build, servedShapeDigests: [] }, [], settled)).toBeNull();
  });

  // Not having looked is not having found nothing: until the workload has been
  // read a day after the build, the shapes not seen are shapes not looked for.
  it("withholds the after until the workload has been read past the settle moment", () => {
    const early = new Date(builtAt.getTime() + 2 * HOUR);
    expect(scansFor(build, [], early)).toEqual({
      shapes: 2,
      weeklyDocsExamined: 18_900_000,
      since: null,
    });
    expect(scansFor(build, [], null)?.since).toBeNull();
  });

  it("reads a shape not written since as one the index took over", () => {
    const shapes = [seen("a", -1), seen("b", -1)];
    expect(scansFor(build, shapes, settled)?.since).toEqual({ shapes: 0, weeklyDocsExamined: 0 });
  });

  it("counts a shape still written after the settle moment as still scanning", () => {
    const shapes = [seen("a", 30, 4_000_000), seen("b", -1)];
    expect(scansFor(build, shapes, settled)?.since).toEqual({
      shapes: 1,
      weeklyDocsExamined: 4_000_000,
    });
  });

  // The ring still holds the scans from before the build for a while, so a
  // shape seen in the first hours says nothing yet.
  it("does not hold the profiler's leftovers against the build", () => {
    const shapes = [seen("a", 3)];
    expect(scansFor(build, shapes, settled)?.since?.shapes).toBe(0);
  });

  // A digest is of the shape alone: the same scan on another collection is not
  // this build's.
  it("matches the build's own collection, not just the digest", () => {
    const elsewhere = { ...seen("a", 30), collection: "orders" };
    expect(scansFor(build, [elsewhere], settled)?.since?.shapes).toBe(0);
  });
});
