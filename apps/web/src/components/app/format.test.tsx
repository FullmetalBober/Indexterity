import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { badgeVariant, DeltaCell, fmtBytes, fmtMicros } from "./format";

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
