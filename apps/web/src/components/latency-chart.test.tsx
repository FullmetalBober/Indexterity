import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type ChartSeries,
  dayLabel,
  LineChart,
  SERIES_PALETTE,
  tooltipTime,
  tooltipValue,
} from "./latency-chart";

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

// "Not enough samples yet" is true of a cluster nobody has collected twice, of
// one that took no writes, and of one whose counters reset — and saying the same
// sentence for all three is what let #85 be reported against a working chart.
describe("LineChart empty note", () => {
  it("says which kind of nothing this is when the caller knows", () => {
    render(
      <LineChart
        title="Write latency"
        unit="µs/op"
        series={[]}
        emptyNote="No write operations recorded over this history."
      />,
    );
    expect(screen.getByText("No write operations recorded over this history.")).toBeInTheDocument();
    expect(screen.queryByText("Not enough samples yet.")).not.toBeInTheDocument();
  });

  it("keeps the generic sentence when it does not", () => {
    render(<LineChart title="Write latency" unit="µs/op" series={[]} emptyNote={null} />);
    expect(screen.getByText("Not enough samples yet.")).toBeInTheDocument();
  });
});

// The tooltip reads a point, and a point carries the datum next to the pixel it
// was painted at: `xValue`/`yValue` against `x`/`y`. Both pairs are numbers, so
// reading the wrong one is silent — and both were being read wrong. The heading
// formatted `x`, so every tooltip said `1/1 03:00` on a Kyiv-time screen (a point
// 40px in is 40ms after 1970-01-01T00:00Z); the value line printed `y`, reporting
// a pixel offset as µs/op, which looks plausible and is therefore worse.
//
// Every point below carries a DIFFERENT number in each pair. That is what makes
// these assertions about which field is read rather than about the format — the
// format itself is asserted against a local copy of it, which would not catch a
// change of format and is not what broke.
const label = (at: Date): string =>
  `${at.getMonth() + 1}/${at.getDate()} ${String(at.getHours()).padStart(2, "0")}:${String(at.getMinutes()).padStart(2, "0")}`;

describe("the tooltip reads the datum, not the pixel", () => {
  const at = new Date("2026-08-11T03:00:00.000Z");

  it("names the group from xValue", () => {
    expect(tooltipTime({ xValue: at, yValue: 58_000, x: 40, y: 137 })).toBe(label(at));
  });

  // The bug, on record as a test: a small number read as a timestamp lands near
  // the epoch whatever the data says.
  it("does not agree with what the pixel would have said", () => {
    expect(tooltipTime({ xValue: 40 })).toBe(label(new Date(40)));
    expect(label(new Date(40))).not.toBe(label(at));
  });

  it("prints the µs/op from yValue", () => {
    expect(tooltipValue({ xValue: at, yValue: 58_000, x: 40, y: 137 }, "µs")).toBe("58000 µs");
    expect(tooltipValue({ xValue: at, yValue: 58_499.6 }, "µs")).toBe("58500 µs");
  });

  // The null points that draw the gaps. Rounding one to `0 µs` would report an
  // idle collection as an instant one.
  it("draws a gap as a dash rather than as zero", () => {
    expect(tooltipValue({ xValue: at, yValue: null }, "µs")).toBe("—");
    expect(tooltipValue(undefined, "µs")).toBe("—");
  });

  it("says nothing rather than 1970 for a time it cannot read", () => {
    expect(tooltipTime(undefined)).toBe("");
    expect(tooltipTime({ xValue: null })).toBe("");
    expect(tooltipTime({ xValue: "not a date" })).toBe("");
  });
});

// A series whose points ARE days must not be labelled to the minute, and must
// not be read in the reader's zone: the buckets are UTC midnights and the scale
// is scaleUtc, so local getters name the day before for anybody west of UTC.
describe("a daily series is labelled in whole UTC days", () => {
  it("writes the day and no time of day", () => {
    expect(dayLabel(new Date("2026-08-09T00:00:00.000Z"))).toBe("8/9");
  });

  // The visible half of the bug: `8/9 03:00` on a chart of daily totals.
  it("does not carry the hour the default format would have added", () => {
    const midnight = new Date("2026-08-09T00:00:00.000Z");
    expect(dayLabel(midnight)).not.toMatch(/:/);
  });

  // The half that was actually wrong. A UTC-midnight bucket is 19:00 the
  // PREVIOUS day in New York, so the local reading named the wrong day — while
  // the scale positioned the point correctly, so the axis disagreed with itself.
  it("names the bucket's own day, not the reader's", () => {
    const midnight = new Date("2026-08-09T00:00:00.000Z");
    // Whatever this machine's zone, the UTC day is the answer.
    expect(dayLabel(midnight)).toBe(`${midnight.getUTCMonth() + 1}/${midnight.getUTCDate()}`);
    // And the last instant of the same UTC day still reads as that day.
    expect(dayLabel(new Date("2026-08-09T23:59:59.000Z"))).toBe("8/9");
  });

  it("says nothing for a time it cannot read", () => {
    expect(dayLabel(null)).toBe("");
    expect(dayLabel(undefined)).toBe("");
    expect(dayLabel("not a date")).toBe("");
  });

  it("is what the tooltip heading uses when it is handed one", () => {
    const at = new Date("2026-08-09T00:00:00.000Z");
    expect(tooltipTime({ xValue: at }, dayLabel)).toBe("8/9");
    // And the default is unchanged for the latency charts.
    expect(tooltipTime({ xValue: at })).toBe(label(at));
  });
});

// fmtBytes writes "4.0 GB" on its own, so appending the axis label as well read
// "4.0 GB bytes".
describe("a value whose format already carries its unit", () => {
  const at = new Date("2026-08-09T00:00:00.000Z");
  const asBytes = (value: number) => `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;

  it("is not given a second unit", () => {
    expect(tooltipValue({ xValue: at, yValue: 4 * 1024 ** 3 }, "", asBytes)).toBe("4.0 GB");
  });

  it("still draws a gap as a dash", () => {
    expect(tooltipValue({ xValue: at, yValue: null }, "", asBytes)).toBe("—");
  });

  it("leaves the suffix alone for a bare number", () => {
    expect(tooltipValue({ xValue: at, yValue: 58_000 }, "µs")).toBe("58000 µs");
  });
});
