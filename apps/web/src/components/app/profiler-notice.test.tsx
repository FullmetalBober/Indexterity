import type { WatchedDatabase } from "@repo/contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PROFILER_RING_DOCS_HREF } from "~/lib/site";
import { renderInApp } from "~/test-utils";
import { ShortProfilerNotice } from "./profiler-notice";

const CHECKED = "2026-10-17T12:00:00.000Z";
const minutesBefore = (minutes: number) =>
  new Date(Date.parse(CHECKED) - minutes * 60_000).toISOString();
const watch = (database: string, reachMinutes: number | null): WatchedDatabase => ({
  database,
  ringCheckedAt: CHECKED,
  ringReachAt: reachMinutes === null ? null : minutesBefore(reachMinutes),
});

// #642. Production's msb-app ring held about 47 minutes, and that was said only
// inside each HIDE line, after the hide.
describe("ShortProfilerNotice", () => {
  it("names a database whose ring holds less than a day, and how to give it one", () => {
    renderInApp(
      <ShortProfilerNotice watched={[watch("msb-app", 47), watch("reports", 2 * 1_440)]} />,
    );

    expect(
      screen.getByText("The profiler on msb-app holds about 47 min of history"),
    ).toBeInTheDocument();
    expect(screen.getByText(/only a query that names the index in a hint/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Make system.profile bigger" })).toHaveAttribute(
      "href",
      PROFILER_RING_DOCS_HREF,
    );
    expect(screen.queryByText(/reports/)).toBeNull();
  });

  it("lists every short ring when there is more than one", () => {
    renderInApp(<ShortProfilerNotice watched={[watch("msb-app", 47), watch("analytics", 190)]} />);

    expect(
      screen.getByText("Some profilers here hold less than a day of history"),
    ).toBeInTheDocument();
    expect(screen.getByText("analytics")).toBeInTheDocument();
    expect(screen.getByText(/about 3 h 10 min/)).toBeInTheDocument();
  });

  // A ring that has not turned over holds everything since the watch began, and
  // one that was never read says nothing either way.
  it("says nothing while no ring is known to be short", () => {
    const { container } = renderInApp(
      <ShortProfilerNotice
        watched={[
          watch("msb-app", null),
          { database: "quiet", ringCheckedAt: null, ringReachAt: null },
        ]}
      />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
