import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { badgeVariant, DeltaCell, dropsOn, fmtBytes, fmtBytesDelta, fmtMicros } from "./format";

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

  it("names the day a hidden drop is due", () => {
    const due = new Date(Date.now() + 5 * 86_400_000);
    expect(dropsOn({ state: "HIDDEN", hiddenAt, observeDays: 7 })).toBe(
      due.toLocaleDateString(undefined, { day: "numeric", month: "short" }),
    );
  });

  // Only HIDDEN has a due date: a proposal has not started its window, and a
  // dropped one has finished.
  it("says nothing in any other state", () => {
    expect(dropsOn({ state: "PROPOSED", hiddenAt: null, observeDays: null })).toBeNull();
    expect(dropsOn({ state: "DROPPED", hiddenAt, observeDays: 7 })).toBeNull();
  });

  // Past the window the drop is waiting on the change window and the
  // regression gate, so a date would be a guess.
  it("says nothing once the window has passed", () => {
    expect(dropsOn({ state: "HIDDEN", hiddenAt, observeDays: 1 })).toBeNull();
  });

  // Older rows predate the per-index window and carry no observeDays.
  it("says nothing without a recorded window", () => {
    expect(dropsOn({ state: "HIDDEN", hiddenAt, observeDays: null })).toBeNull();
  });
});
