import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { present } from "~/lib/at";
import { renderInApp } from "~/test-utils";
import {
  badgeVariant,
  DeltaCell,
  DropsOn,
  dropsOn,
  fmtBytes,
  fmtBytesDelta,
  fmtMicros,
} from "./format";

describe("badgeVariant", () => {
  // The badge is the only thing distinguishing a drop from a build at a glance,
  // so a new recommendation type must not silently inherit the destructive one.
  it("marks only the irreversible-looking drop destructive", () => {
    expect(badgeVariant("DROP_UNUSED")).toBe("destructive");
    expect(badgeVariant("DROP_REDUNDANT")).toBe("secondary");
    expect(badgeVariant("ADVISORY_REVIEW")).toBe("secondary");
  });

  it("treats every additive type the same", () => {
    for (const type of ["CREATE", "UPDATE", "MERGE"]) {
      expect(badgeVariant(type)).toBe("outline");
    }
  });

  it("falls back to additive for a type it has never seen", () => {
    expect(badgeVariant("SOMETHING_NEW")).toBe("outline");
  });
});

describe("fmtBytes", () => {
  it("switches to MB at a megabyte", () => {
    expect(fmtBytes(1024 * 1024)).toBe("1.0 MB");
    expect(fmtBytes(1024 * 1024 - 1)).toBe("1024 KB");
  });

  it("rounds kilobytes to whole numbers", () => {
    expect(fmtBytes(4096)).toBe("4 KB");
    expect(fmtBytes(0)).toBe("0 KB");
  });

  // #160: an index footprint reaches gigabytes, and `6144.0 MB` is a number
  // nobody converts in their head.
  it("switches to GB at a gigabyte", () => {
    expect(fmtBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(fmtBytes(6 * 1024 * 1024 * 1024)).toBe("6.0 GB");
    expect(fmtBytes(1024 * 1024 * 1024 - 1)).toBe("1024.0 MB");
  });

  // The footprint delta is negative when the cluster carries less index than it
  // did, which is the answer the panel exists to give.
  it("keeps the sign of a shrinking footprint at every tier", () => {
    expect(fmtBytes(-2 * 1024 * 1024 * 1024)).toBe("-2.0 GB");
    expect(fmtBytes(-2 * 1024 * 1024)).toBe("-2.0 MB");
    expect(fmtBytes(-4096)).toBe("-4 KB");
  });
});

describe("fmtBytesDelta", () => {
  it("writes the sign both ways, because growth is the finding", () => {
    expect(fmtBytesDelta(6 * 1024 * 1024 * 1024)).toBe("+6.0 GB");
    expect(fmtBytesDelta(-4 * 1024 * 1024 * 1024)).toBe("-4.0 GB");
    expect(fmtBytesDelta(0)).toBe("0 KB");
  });
});

describe("fmtMicros", () => {
  it("renders a dash rather than a zero when there is no measurement", () => {
    expect(fmtMicros(null)).toBe("—");
    expect(fmtMicros(0)).toBe("0");
  });

  it("rounds", () => {
    expect(fmtMicros(1234.6)).toBe("1235");
  });
});

describe("DeltaCell", () => {
  // Green for faster, red for slower. Getting the sign backwards would read as
  // a win every time the cluster got worse.
  it("is green and unsigned when latency fell", () => {
    render(<DeltaCell pct={-12.4} />);
    const cell = screen.getByText("-12%");
    expect(cell).toHaveClass("text-green-600");
  });

  it("is red and explicitly signed when latency rose", () => {
    render(<DeltaCell pct={8.2} />);
    const cell = screen.getByText("+8%");
    expect(cell).toHaveClass("text-red-600");
  });

  it("stays neutral at exactly zero", () => {
    render(<DeltaCell pct={0} />);
    expect(screen.getByText("0%")).toHaveClass("text-muted-foreground");
  });

  it("renders a dash when there is nothing to compare", () => {
    render(<DeltaCell pct={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});

describe("dropsOn", () => {
  const hiddenAt = new Date(Date.now() - 2 * 86_400_000).toISOString();

  // The INSTANT, not a formatted date: the drawing happens in the reader's zone
  // behind the hydration gate, so a server that formatted here would write its own
  // timezone into the HTML (see DropsOn).
  it("names the instant a hidden drop is due", () => {
    const due = new Date(Date.now() + 5 * 86_400_000);
    const answer = dropsOn({ state: "HIDDEN", hiddenAt, observeDays: 7 });
    expect(answer).not.toBeNull();
    // Same millisecond arithmetic, allowing for the clock moving during the test.
    expect(
      Math.abs(new Date(present(answer, "the formatted date")).getTime() - due.getTime()),
    ).toBeLessThan(5_000);
  });

  // Only HIDDEN has a due date: a proposal has not started its window, and a
  // dropped one has finished.
  it("says nothing in any other state", () => {
    expect(dropsOn({ state: "PROPOSED", hiddenAt: null, observeDays: null })).toBeNull();
    expect(dropsOn({ state: "DROPPED", hiddenAt, observeDays: 7 })).toBeNull();
  });

  // Past the window the drop is waiting on the change window and the regression
  // gate, so a date would be a guess — but that comparison is against the READER's
  // clock, so it moved into DropsOn below and this function answers on state and
  // window alone.
  it("still answers for a window that has already passed", () => {
    expect(dropsOn({ state: "HIDDEN", hiddenAt, observeDays: 1 })).not.toBeNull();
  });

  // Older rows predate the per-index window and carry no observeDays.
  it("says nothing without a recorded window", () => {
    expect(dropsOn({ state: "HIDDEN", hiddenAt, observeDays: null })).toBeNull();
  });
});

// The rule that used to live in dropsOn, where it can be applied against the
// clock it depends on. Nothing is drawn until mounted either, which is what keeps
// the server's markup and the hydration pass identical.
describe("DropsOn", () => {
  const hiddenAt = new Date(Date.now() - 2 * 86_400_000).toISOString();

  it("names the day once mounted", async () => {
    renderInApp(<DropsOn rec={{ state: "HIDDEN", hiddenAt, observeDays: 7 }} />);

    expect(await screen.findByText(/drops/)).toBeInTheDocument();
  });

  // Not a date, because past the window the timing is the change window's to
  // decide and any date would be invented — but not nothing either, which read
  // as "no drop pending" for what is actually a queued one (#268).
  it("says what an overdue drop is waiting for, rather than nothing", async () => {
    renderInApp(<DropsOn rec={{ state: "HIDDEN", hiddenAt, observeDays: 1 }} />);

    expect(await screen.findByText(/waiting on the change window/)).toBeInTheDocument();
    expect(screen.queryByText(/drops/)).not.toBeInTheDocument();
  });

  // #269. The window is per-index and the number alone reads as arbitrary next
  // to a neighbour with a different one; the engine already wrote the sentence
  // that explains it.
  it("explains the window when the engine had a reason for it", async () => {
    renderInApp(
      <DropsOn
        rec={{
          state: "HIDDEN",
          hiddenAt,
          observeDays: 60,
          observeReason: "periodic usage with gaps up to 30 days — window extended",
        }}
      />,
    );

    await userEvent.hover(await screen.findByText(/drops/));
    expect(await screen.findByText(/periodic usage with gaps up to 30 days/)).toBeInTheDocument();
  });

  it("adds no explanation when the policy baseline applied unchanged", async () => {
    renderInApp(
      <DropsOn rec={{ state: "HIDDEN", hiddenAt, observeDays: 7, observeReason: null }} />,
    );

    const label = await screen.findByText(/drops/);
    await userEvent.hover(label);
    expect(document.querySelector("[data-slot='tooltip-trigger']")).toBeNull();
  });

  it("says nothing for a state that has no window", () => {
    renderInApp(<DropsOn rec={{ state: "PROPOSED", hiddenAt: null, observeDays: null }} />);

    expect(screen.queryByText(/drops/)).not.toBeInTheDocument();
    expect(screen.queryByText(/waiting/)).not.toBeInTheDocument();
  });
});
