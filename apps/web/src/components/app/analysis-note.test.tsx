import type { AnalysisNote } from "@repo/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AnalysisNotePanel } from "./analysis-note";

function note(overrides: Partial<AnalysisNote> = {}): AnalysisNote {
  return {
    decidedAt: "2026-08-20T13:00:00.000Z",
    consideredIndexes: 12,
    trustedIndexes: 0,
    usagePaused: true,
    dominantRefusal: "span-too-short",
    refusedIndexes: 12,
    explanation:
      "We have been watching this cluster for less than 7 days. Redundancy findings are unaffected.",
    suppressed: [],
    ...overrides,
  };
}

describe("AnalysisNotePanel", () => {
  // The state the panel exists for: nothing cleared the usage gate, so the empty
  // list below reads as "all fine" when it means "we cannot tell yet".
  it("says usage recommendations are paused, and why", () => {
    render(<AnalysisNotePanel analysis={note()} />);
    expect(screen.getByText(/Usage-based recommendations are paused/)).toBeInTheDocument();
    expect(screen.getByText(/less than 7 days/)).toBeInTheDocument();
    expect(screen.getByText(/12 indexes affected/)).toBeInTheDocument();
  });

  // Before the first classify pass there is no answer, and "all clear" is the one
  // thing that must never be drawn from the absence of one (D19).
  it("draws nothing at all when no pass has explained itself yet", () => {
    const { container } = render(<AnalysisNotePanel analysis={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  // A pass that ran and had nothing to explain is silence, not a panel saying so.
  it("draws nothing when nothing was refused and nothing suppressed", () => {
    const { container } = render(
      <AnalysisNotePanel
        analysis={note({
          trustedIndexes: 12,
          usagePaused: false,
          dominantRefusal: null,
          refusedIndexes: 0,
          explanation: null,
        })}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  // Partial is ordinary — any cluster with old and new indexes has some of each —
  // so it gets a line rather than an alert. A box that appears on every cluster
  // is a box nobody reads by the time it matters.
  it("reports a partial refusal quietly, without the paused headline", () => {
    render(
      <AnalysisNotePanel
        analysis={note({
          trustedIndexes: 9,
          usagePaused: false,
          dominantRefusal: "span-too-short",
          refusedIndexes: 3,
          explanation: "We have been watching this cluster for less than 7 days.",
        })}
      />,
    );
    expect(screen.queryByText(/paused/)).not.toBeInTheDocument();
    expect(screen.getByText(/3 indexes of 12 not yet usable/)).toBeInTheDocument();
    expect(screen.getByText(/less than 7 days/)).toBeInTheDocument();
  });

  // The other half of #277: a guard that withholds a finding leaves no trace, so
  // "nothing to suggest" and "we suggested it and hid it" render the same.
  it("lists what the collision guards held back", () => {
    render(
      <AnalysisNotePanel
        analysis={note({
          trustedIndexes: 12,
          usagePaused: false,
          dominantRefusal: null,
          refusedIndexes: 0,
          explanation: null,
          suppressed: [
            { guard: "cooldown", findings: 2, explanation: "2 findings held back: parked." },
            { guard: "watched", findings: 1, explanation: "1 finding held back: still watching." },
          ],
        })}
      />,
    );
    expect(screen.getByText("2 findings held back: parked.")).toBeInTheDocument();
    expect(screen.getByText("1 finding held back: still watching.")).toBeInTheDocument();
  });

  it("draws both halves when both apply", () => {
    render(
      <AnalysisNotePanel
        analysis={note({
          suppressed: [
            { guard: "standing", findings: 4, explanation: "4 findings held back: standing." },
          ],
        })}
      />,
    );
    expect(screen.getByText(/Usage-based recommendations are paused/)).toBeInTheDocument();
    expect(screen.getByText("4 findings held back: standing.")).toBeInTheDocument();
  });
});
