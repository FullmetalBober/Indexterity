import type { BuildImpact, ClusterRecommendations, ClusterRoi } from "@repo/contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NO_RECOMMENDATIONS, NO_ROI } from "~/lib/queries/pipeline";
import type { Read } from "~/lib/queries/read";
import { renderInApp } from "~/test-utils";
import { BuiltByIndex, ImpactCards, scanningRemoved } from "./impact";

function read<T>(data: T, over: Partial<Read<T>> = {}): Read<T> {
  return { data, pending: false, failed: false, retry: vi.fn(), ...over };
}

function recommendations(summary: Partial<ClusterRecommendations["summary"]> = {}) {
  return read<ClusterRecommendations>({
    ...NO_RECOMMENDATIONS,
    summary: { ...NO_RECOMMENDATIONS.summary, ...summary },
  });
}

function build(over: Partial<BuildImpact> = {}): BuildImpact {
  return {
    recommendationId: "00000000-0000-4000-8000-000000000001",
    type: "CREATE",
    database: "app",
    collection: "settings",
    indexName: "userId_1",
    builtAt: "2026-09-04T03:00:00.000Z",
    readsBefore: { ops: 89_734, avgMicros: 900 },
    readsAfter: { ops: 114_881, avgMicros: 310 },
    afterDays: 7,
    scans: null,
    ...over,
  };
}

describe("ImpactCards", () => {
  // #608: the drops an owner already approved wait in APPROVED and HIDDEN, and
  // a PROPOSED-only sum read 0 KB on every production cluster.
  it("draws reclaimable from the api's summary of every open drop", () => {
    renderInApp(
      <ImpactCards
        recommendations={recommendations({
          drops: { toReview: 0, underWay: 8, reclaimableBytes: 4.6 * 1024 ** 3 },
        })}
        roi={read<ClusterRoi>(NO_ROI)}
      />,
    );

    expect(screen.getByText("4.6 GB")).toBeInTheDocument();
    expect(screen.getByText("0 drops to review · 8 under way")).toBeInTheDocument();
  });

  it("says nothing is open rather than drawing two zeroes", () => {
    renderInApp(<ImpactCards recommendations={recommendations()} roi={read<ClusterRoi>(NO_ROI)} />);

    expect(screen.getByText("No drops open")).toBeInTheDocument();
    expect(screen.getByText("No builds open")).toBeInTheDocument();
  });

  it("names no price for what was reclaimed", () => {
    renderInApp(
      <ImpactCards
        recommendations={recommendations()}
        roi={read<ClusterRoi>({ ...NO_ROI, freedBytes: 32_768, indexesDropped: 1 })}
      />,
    );

    expect(screen.getByText("1 index dropped")).toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it("puts the open builds' scanning beside how many builds wait", () => {
    renderInApp(
      <ImpactCards
        recommendations={recommendations({
          builds: {
            toReview: 52,
            underWay: 28,
            scanningShapes: 68,
            weeklyDocsExamined: 1_470_857_963,
          },
        })}
        roi={read<ClusterRoi>(NO_ROI)}
      />,
    );

    expect(screen.getByText("1.5B")).toBeInTheDocument();
    expect(
      screen.getByText("68 query shapes · 52 builds to review · 28 under way"),
    ).toBeInTheDocument();
  });

  // The two reads fail apart: a dead ROI read costs its own two cards.
  it("withholds only the figures of the read that failed", () => {
    renderInApp(
      <ImpactCards
        recommendations={recommendations({
          drops: { toReview: 1, underWay: 0, reclaimableBytes: 2048 },
        })}
        roi={read<ClusterRoi>(NO_ROI, { failed: true })}
      />,
    );

    expect(screen.getByText("2 KB")).toBeInTheDocument();
    expect(screen.getAllByText(/Could not load this/)).toHaveLength(2);
  });
});

describe("scanningRemoved", () => {
  it("is unknown until a build has been measured, rather than zero", () => {
    expect(scanningRemoved([build()])).toBeNull();
    expect(
      scanningRemoved([build({ scans: { shapes: 1, weeklyDocsExamined: 100, since: null } })]),
    ).toBeNull();
  });

  it("adds what each measured build took off, never less than nothing", () => {
    expect(
      scanningRemoved([
        build({
          scans: {
            shapes: 1,
            weeklyDocsExamined: 18_900_000,
            since: { shapes: 0, weeklyDocsExamined: 0 },
          },
        }),
        // A shape still scanning, busier than when the index was built.
        build({
          scans: {
            shapes: 1,
            weeklyDocsExamined: 100,
            since: { shapes: 1, weeklyDocsExamined: 400 },
          },
        }),
      ]),
    ).toBe(18_900_000);
  });
});

describe("BuiltByIndex", () => {
  it("compares the collection's reads either side of the build", () => {
    renderInApp(<BuiltByIndex builds={[build()]} total={1} />);

    expect(screen.getByText(/Reads 900 µs → 310 µs/)).toBeInTheDocument();
    expect(screen.getByText("-66%")).toBeInTheDocument();
  });

  // 157 reads before and 29 after on a dev cluster: the averages moved by half
  // for reasons that had nothing to do with the index.
  it("withholds the comparison below the floor of reads", () => {
    renderInApp(
      <BuiltByIndex
        builds={[
          build({
            readsBefore: { ops: 157, avgMicros: 376_520 },
            readsAfter: { ops: 29, avgMicros: 576_800 },
          }),
        ]}
        total={1}
      />,
    );

    expect(
      screen.getByText("Reads: too few to compare (157 before, 29 after)"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("says how much of the week after has passed", () => {
    renderInApp(<BuiltByIndex builds={[build({ afterDays: 2.4 })]} total={1} />);

    expect(screen.getByText(/2 days after so far/)).toBeInTheDocument();
  });

  it("tells a shape that stopped from one that was not looked for yet", () => {
    renderInApp(
      <BuiltByIndex
        builds={[
          build({
            recommendationId: "00000000-0000-4000-8000-000000000001",
            scans: {
              shapes: 1,
              weeklyDocsExamined: 18_900_000,
              since: { shapes: 0, weeklyDocsExamined: 0 },
            },
          }),
          build({
            recommendationId: "00000000-0000-4000-8000-000000000002",
            indexName: "createdAt_1",
            scans: { shapes: 2, weeklyDocsExamined: 150_000_000, since: null },
          }),
        ]}
        total={2}
      />,
    );

    expect(
      screen.getByText(
        "1 query shape scanning 18.9M docs/week when built; none seen scanning since.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "2 query shapes scanning 150.0M docs/week when built; checked a day after the build.",
      ),
    ).toBeInTheDocument();
  });

  it("is not drawn for a cluster with nothing built", () => {
    renderInApp(<BuiltByIndex builds={[]} total={0} />);

    expect(screen.queryByText("Built by index")).not.toBeInTheDocument();
  });
});
