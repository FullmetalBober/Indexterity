import type { ClusterPasses, PassTiming } from "@repo/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { fmtDuration, PassesPanel } from "./passes-panel";

function timing(overrides: Partial<PassTiming>): PassTiming {
  return {
    task: "collect",
    startedAt: "2026-10-01T12:00:00.000Z",
    durationMs: 4_000,
    outcome: "ok",
    budgetMs: 300_000,
    phases: [],
    pace: null,
    ...overrides,
  };
}

function passes(...entries: PassTiming[]): ClusterPasses {
  return { clusterId: "c1", passes: entries };
}

describe("fmtDuration", () => {
  it("says a duration the way a person would", () => {
    expect(fmtDuration(380)).toBe("380 ms");
    expect(fmtDuration(4_250)).toBe("4.2 s");
    expect(fmtDuration(42_900)).toBe("42 s");
    expect(fmtDuration(300_000)).toBe("5 min");
    expect(fmtDuration(252_000)).toBe("4 min 12 s");
    expect(fmtDuration(3_600_000)).toBe("1 h");
    expect(fmtDuration(3_900_000)).toBe("1 h 5 min");
  });
});

describe("PassesPanel", () => {
  // The ceiling beside the number: a duration means nothing until you know what
  // the pass was allowed (#571).
  it("reads each duration against the budget it ran under", () => {
    render(<PassesPanel passes={passes(timing({ durationMs: 252_000 }))} loading={false} />);
    expect(screen.getByText("took 4 min 12 s of its 5 min")).toBeInTheDocument();
  });

  it("says only how long a pass with no budget took", () => {
    render(
      <PassesPanel
        passes={passes(timing({ task: "apply", budgetMs: null, durationMs: 1_200 }))}
        loading={false}
      />,
    );
    expect(screen.getByText("took 1.2 s")).toBeInTheDocument();
  });

  // The case the panel exists for: a pass that landed, but with so little room
  // that the next slower hour is the one it does not fit in.
  it("calls out a pass that landed close to its budget", () => {
    render(<PassesPanel passes={passes(timing({ durationMs: 240_000 }))} loading={false} />);
    expect(screen.getByText("close to its budget")).toBeInTheDocument();
  });

  it("gives an ordinary landed pass no badge at all", () => {
    render(<PassesPanel passes={passes(timing({ durationMs: 4_000 }))} loading={false} />);
    expect(screen.queryByText("close to its budget")).not.toBeInTheDocument();
  });

  it("names how a pass that did not land ended", () => {
    render(
      <PassesPanel
        passes={passes(
          timing({ outcome: "timed-out", durationMs: 300_000 }),
          timing({ task: "probe", outcome: "unreachable", durationMs: 30_000 }),
        )}
        loading={false}
      />,
    );
    expect(screen.getByText("ran out of time")).toBeInTheDocument();
    expect(screen.getByText("could not reach the cluster")).toBeInTheDocument();
  });

  // Adding an outcome is a constant on the api, so this must degrade rather than
  // throw or draw nothing.
  it("shows an outcome it has no wording for by its name", () => {
    render(<PassesPanel passes={passes(timing({ outcome: "throttled" }))} loading={false} />);
    expect(screen.getByText("throttled")).toBeInTheDocument();
  });

  it("says where the time went, and which phase a budget cut off", () => {
    render(
      <PassesPanel
        passes={passes(
          timing({
            outcome: "timed-out",
            durationMs: 300_000,
            phases: [
              { name: "queryStorePlans", totalMs: 241_000, calls: 13, running: true },
              { name: "indexUsage", totalMs: 52_000, calls: 1, running: false },
            ],
          }),
        )}
        loading={false}
      />,
    );
    expect(
      screen.getByText(
        "Where the time went: queryStorePlans 4 min 1 s over 13 calls, still running; indexUsage 52 s",
      ),
    ).toBeInTheDocument();
  });

  // Read the cluster, decide, change it — the order a pass of data moves, not the
  // order the api happens to return rows in.
  it("lists the passes in the pipeline's order", () => {
    render(
      <PassesPanel
        passes={passes(
          timing({ task: "probe" }),
          timing({ task: "apply", budgetMs: null }),
          timing({ task: "collect" }),
          timing({ task: "suggest" }),
        )}
        loading={false}
      />,
    );
    const names = screen
      .getAllByText(/^(collect|suggest|probe|apply)$/)
      .map((node) => node.textContent);
    expect(names).toEqual(["collect", "suggest", "probe", "apply"]);
  });

  // #571. The trade said as a trade: longer, and less often, by the same factor.
  it("says how a paced collect runs from now on", () => {
    render(
      <PassesPanel
        passes={passes(
          timing({
            outcome: "timed-out",
            durationMs: 300_000,
            pace: { everyHours: 2, budgetMs: 600_000 },
          }),
        )}
        loading={false}
      />,
    );
    expect(screen.getByText("every 2 h")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Paced: runs every 2 hours with 10 min, because a collect here needs longer than an hourly one is given.",
      ),
    ).toBeInTheDocument();
  });

  // #588. A suggest is paced on a tier of its own, and the panel says so in the
  // same words — the pass's own name, not the collect's.
  it("says how a paced suggest runs from now on", () => {
    render(
      <PassesPanel
        passes={passes(
          timing({
            task: "suggest",
            outcome: "ok",
            durationMs: 900_000,
            budgetMs: 1_200_000,
            pace: { everyHours: 4, budgetMs: 1_200_000 },
          }),
        )}
        loading={false}
      />,
    );
    expect(screen.getByText("every 4 h")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Paced: runs every 4 hours with 20 min, because a suggest here needs longer than an hourly one is given.",
      ),
    ).toBeInTheDocument();
  });

  it("says nothing about pace for a pass that is not paced", () => {
    render(<PassesPanel passes={passes(timing({}))} loading={false} />);
    expect(screen.queryByText(/^Paced:/)).not.toBeInTheDocument();
  });

  it("says nothing has been timed before the first pass", () => {
    render(<PassesPanel passes={passes()} loading={false} />);
    expect(screen.getByText("No pass timed yet")).toBeInTheDocument();
  });

  it("draws nothing while the first read is in flight", () => {
    const { container } = render(<PassesPanel passes={null} loading={true} />);
    expect(container).toBeEmptyDOMElement();
  });
});
