import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type ChartSeries, LineChart, SERIES_PALETTE } from "./latency-chart";

// Two collections over three collects, with a hole in the second — the shape the
// telemetry query actually produces.
const SERIES: ChartSeries[] = [
  {
    label: "shop.orders",
    color: SERIES_PALETTE[0] ?? "#00A35C",
    points: [
      { t: "2026-08-01T00:00:00.000Z", v: 120 },
      { t: "2026-08-01T06:00:00.000Z", v: 90 },
      { t: "2026-08-01T12:00:00.000Z", v: 80 },
    ],
  },
  {
    label: "shop.users",
    color: SERIES_PALETTE[1] ?? "#016BF8",
    points: [
      { t: "2026-08-01T00:00:00.000Z", v: 40 },
      // The collect ran but this collection served no reads — a gap, not a zero.
      { t: "2026-08-01T06:00:00.000Z", v: null },
      { t: "2026-08-01T12:00:00.000Z", v: 55 },
    ],
  },
];

describe("LineChart", () => {
  it("draws a chart with an accessible name naming the unit", () => {
    render(<LineChart title="Read latency" unit="µs/op" series={SERIES} />);

    expect(screen.getByRole("heading", { name: "Read latency" })).toBeInTheDocument();
    expect(screen.getByLabelText("Read latency per collection, in µs/op")).toBeInTheDocument();
  });

  // The chart is pre-1.0 and behind a wrapper on purpose. Asserting that an
  // <svg> with paths comes out is what catches a breaking release as a failing
  // test rather than as a blank panel on the dashboard.
  it("renders svg paths, one per series", () => {
    const { container } = render(<LineChart title="Read latency" unit="µs/op" series={SERIES} />);

    const svg = container.querySelector("svg[aria-label]");
    expect(svg).not.toBeNull();
    // Two series, and the palette colors reach the strokes.
    const strokes = [...container.querySelectorAll("path[stroke]")].map((node) =>
      node.getAttribute("stroke"),
    );
    expect(strokes).toContain(SERIES_PALETTE[0]);
    expect(strokes).toContain(SERIES_PALETTE[1]);
  });

  it("names every series in the legend", () => {
    render(<LineChart title="Read latency" unit="µs/op" series={SERIES} />);

    expect(screen.getByText("shop.orders")).toBeInTheDocument();
    expect(screen.getByText("shop.users")).toBeInTheDocument();
  });

  // A single collect cannot be a line, and saying so beats an axis with one dot.
  it("says so rather than drawing a line through one point", () => {
    render(
      <LineChart
        title="Read latency"
        unit="µs/op"
        series={[
          {
            label: "shop.orders",
            color: SERIES_PALETTE[0] ?? "#00A35C",
            points: [{ t: "2026-08-01T00:00:00.000Z", v: 120 }],
          },
        ]}
      />,
    );

    expect(screen.getByText("Not enough samples yet.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  // Timestamps exist but every reading is null: the collector ran and the
  // collection was idle. There is nothing to plot, and a flat line at zero would
  // be a claim about latency rather than an absence of one.
  it("treats an all-null series as nothing to plot", () => {
    render(
      <LineChart
        title="Write latency"
        unit="µs/op"
        series={[
          {
            label: "shop.orders",
            color: SERIES_PALETTE[0] ?? "#00A35C",
            points: [
              { t: "2026-08-01T00:00:00.000Z", v: null },
              { t: "2026-08-01T06:00:00.000Z", v: null },
            ],
          },
        ]}
      />,
    );

    expect(screen.getByText("Not enough samples yet.")).toBeInTheDocument();
  });

  it("takes no series at all without throwing", () => {
    render(<LineChart title="Read latency" unit="µs/op" series={[]} />);
    expect(screen.getByText("Not enough samples yet.")).toBeInTheDocument();
  });

  // The chart the recharts version replaced could not do this: recharts 3 draws
  // client-side only, so SSR shipped the section and an empty box that filled in
  // on hydration. This one is a scene rendered to SVG from a known size, so the
  // server can draw it — worth a test, because losing it would be a silent
  // regression to a chart that pops in.
  it("renders on the server, lines and all", () => {
    const html = renderToString(<LineChart title="Read latency" unit="µs/op" series={SERIES} />);

    expect(html).toContain("<svg");
    expect(html).toContain(SERIES_PALETTE[0] ?? "");
    expect(html).toContain(SERIES_PALETTE[1] ?? "");
    expect(html).not.toContain("Not enough samples yet.");
  });
});
