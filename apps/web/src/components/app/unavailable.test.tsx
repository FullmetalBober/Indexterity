import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Unavailable, UnavailableFigure } from "./unavailable";

describe("Unavailable", () => {
  // The whole point of #289: a failed read must not be reported as a finding
  // about the customer's database.
  it("says the failure is ours, not the cluster's", () => {
    render(<Unavailable what="recommendations" onRetry={() => {}} />);
    expect(screen.getByText("Could not load recommendations")).toBeInTheDocument();
    expect(screen.getByText(/not a finding about your cluster/)).toBeInTheDocument();
    expect(screen.getByText(/nothing was read from it/)).toBeInTheDocument();
  });

  // No count, no zero, no "none found". The only honest statement available is
  // that we do not know.
  it("claims nothing about the data", () => {
    const { container } = render(<Unavailable what="the parked list" onRetry={() => {}} />);
    expect(container.textContent).not.toMatch(
      /\b0\b|\bno\s+\w+\s+(yet|found)\b|nothing to review/i,
    );
  });

  it("offers a retry that calls back", async () => {
    const onRetry = vi.fn();
    render(<Unavailable what="recommendations" onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});

describe("UnavailableFigure", () => {
  // A figure is a measurement and a failed read took none — the same argument
  // the pending skeleton beside it already makes.
  it("draws a dash rather than a zero, and says so in words", () => {
    const { container } = render(<UnavailableFigure onRetry={() => {}} />);
    expect(container.textContent).toContain("—");
    expect(container.textContent).not.toMatch(/\b0\b/);
    // The dash is decorative; the sentence is what a screen reader gets.
    expect(screen.getByText(/Could not load this/)).toBeInTheDocument();
  });

  it("offers a retry that calls back", async () => {
    const onRetry = vi.fn();
    render(<UnavailableFigure onRetry={onRetry} />);
    await userEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });
});
