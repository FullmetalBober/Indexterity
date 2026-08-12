import type { ClusterIndexSizeSeries, IndexSizePoint } from "@repo/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FootprintPanel } from "./footprint-panel";

const GB = 1024 * 1024 * 1024;

function day(n: number, totalBytes: number | null): IndexSizePoint {
  return {
    day: `2026-08-${String(n).padStart(2, "0")}T00:00:00.000Z`,
    totalBytes,
    indexCount: totalBytes === null ? 0 : 12,
  };
}

// The api computes the three summary fields off the DRAWABLE ends of the series
// (#160), so the fixtures state them rather than deriving them here — deriving
// them would be the browser recomputing the thing the api computes to stop it
// getting recomputed wrong.
function payload(overrides: Partial<ClusterIndexSizeSeries> = {}): ClusterIndexSizeSeries {
  return {
    clusterId: "c1",
    firstBytes: 10 * GB,
    latestBytes: 8 * GB,
    changeBytes: -2 * GB,
    points: [day(1, 10 * GB), day(2, 9 * GB), day(3, 8 * GB)],
    ...overrides,
  };
}

describe("FootprintPanel", () => {
  it("leads with the current footprint and how far it has moved", () => {
    render(<FootprintPanel series={payload()} loading={false} />);
    expect(screen.getByText("8.0 GB")).toBeInTheDocument();
    expect(screen.getByText(/-2\.0 GB over the window/)).toBeInTheDocument();
    expect(screen.getByText(/smaller than it was/)).toBeInTheDocument();
  });

  // The finding the ROI panel structurally cannot report: it counts only what
  // the engine removed, so it has no way to say the cluster grew anyway.
  it("says so when the footprint grew, and marks it", () => {
    render(
      <FootprintPanel
        series={payload({
          firstBytes: 8 * GB,
          latestBytes: 14 * GB,
          changeBytes: 6 * GB,
          points: [day(1, 8 * GB), day(2, 14 * GB)],
        })}
        loading={false}
      />,
    );
    expect(screen.getByText(/\+6\.0 GB over the window/)).toBeInTheDocument();
    expect(screen.getByText(/larger than it was/)).toBeInTheDocument();
    expect(screen.getByText("14.0 GB")).toHaveClass("text-red-600");
  });

  // Steady is an answer, and a different one from "we do not know".
  it("distinguishes an unchanged footprint from an unknown one", () => {
    render(
      <FootprintPanel
        series={payload({
          firstBytes: 4 * GB,
          latestBytes: 4 * GB,
          changeBytes: 0,
          points: [day(1, 4 * GB), day(2, 4 * GB)],
        })}
        loading={false}
      />,
    );
    expect(screen.getByText(/cancel out/)).toBeInTheDocument();
  });

  it("has no trend to report from one collected day", () => {
    render(
      <FootprintPanel
        series={payload({
          firstBytes: 4 * GB,
          latestBytes: 4 * GB,
          changeBytes: null,
          points: [day(1, null), day(2, 4 * GB)],
        })}
        loading={false}
      />,
    );
    expect(screen.getByText("4.0 GB")).toBeInTheDocument();
    expect(screen.getByText(/a trend needs two/)).toBeInTheDocument();
  });

  // Nothing collected is a statement about us, not about the cluster, and it
  // must not render as a footprint of zero.
  it("says nothing has been collected rather than showing 0", () => {
    render(
      <FootprintPanel
        series={payload({
          firstBytes: null,
          latestBytes: null,
          changeBytes: null,
          points: [day(1, null), day(2, null)],
        })}
        loading={false}
      />,
    );
    expect(screen.getByText("Nothing collected yet")).toBeInTheDocument();
    expect(screen.queryByText("0 KB")).not.toBeInTheDocument();
  });

  // The axis and the tooltip are labelled for a DAILY series. The default
  // format writes `8/9 03:00`, which is precise to the minute about a whole
  // day's total and, read in the local zone, names the previous day for anybody
  // west of UTC — against a scale that positions the point correctly.
  it("labels the axis in whole days, with no time of day", () => {
    const { container } = render(<FootprintPanel series={payload()} loading={false} />);
    const ticks = [...container.querySelectorAll("text")].map((node) => node.textContent ?? "");
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.some((text) => /^\d+\/\d+$/.test(text))).toBe(true);
    // No `HH:MM` anywhere on the axis.
    expect(ticks.some((text) => /\d:\d\d/.test(text))).toBe(false);
  });

  // Not "per collection": this series is the cluster's total, and the
  // Collections table below is where a per-namespace figure lives.
  it("names itself as a cluster-wide daily series", () => {
    render(<FootprintPanel series={payload()} loading={false} />);
    expect(
      screen.getByLabelText("Total index bytes across the cluster, one point per day"),
    ).toBeInTheDocument();
  });

  // The panel claims nothing about the cluster before the read has answered.
  it("stays quiet while the first fetch is out", () => {
    render(
      <FootprintPanel
        series={{
          clusterId: "",
          firstBytes: null,
          latestBytes: null,
          changeBytes: null,
          points: [],
        }}
        loading={true}
      />,
    );
    expect(screen.queryByText("Nothing collected yet")).not.toBeInTheDocument();
  });
});
