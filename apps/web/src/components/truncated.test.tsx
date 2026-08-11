import { screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Truncated } from "~/components/truncated";
import { renderInApp } from "~/test-utils";

// jsdom lays nothing out: every element reports 0 for both widths, so "does the
// text fit" has no natural answer here. These stub the two properties the
// component asks about, which is the whole of its input — the alternative is a
// browser, and the e2e suite is where a browser lives.
const stubWidths = (scrollWidth: number, clientWidth: number): void => {
  for (const [name, value] of [
    ["scrollWidth", scrollWidth],
    ["clientWidth", clientWidth],
  ] as const) {
    Object.defineProperty(HTMLElement.prototype, name, {
      configurable: true,
      get: () => value,
    });
  }
};

afterEach(() => {
  for (const name of ["scrollWidth", "clientWidth"]) {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
});

describe("Truncated", () => {
  it("draws the text alone when it fits", () => {
    stubWidths(200, 200);
    renderInApp(<Truncated>reads zero across a full week</Truncated>);
    expect(screen.getByText("reads zero across a full week")).toBeInTheDocument();
    // No trigger, so no hover target and nothing for a keyboard to stop on: a
    // tooltip over text that is fully visible is furniture in the way of the row
    // underneath it.
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  // The pixel of tolerance. Sub-pixel layout makes scrollWidth exceed clientWidth
  // by fractions on text that is plainly not clipped, and without this nearly
  // every cell would carry a tooltip.
  it("ignores a sub-pixel overhang", () => {
    stubWidths(201, 200.4);
    renderInApp(<Truncated>reads zero across a full week</Truncated>);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("becomes a tooltip trigger once the text is clipped", async () => {
    stubWidths(420, 200);
    renderInApp(
      <Truncated>no recorded usage in 14 days, and the collection was queried</Truncated>,
    );
    // Radix marks the trigger, which is what a pointer and a keyboard both find.
    await waitFor(() => {
      expect(screen.getByText(/no recorded usage/)).toHaveAttribute("data-slot", "tooltip-trigger");
    });
  });

  it("clips on one line rather than wrapping to three", () => {
    stubWidths(200, 200);
    renderInApp(<Truncated>reads zero across a full week</Truncated>);
    // Uniform row heights are what keep the virtualizer's estimates honest, so a
    // cell that grew to two lines would misplace every row after it.
    expect(screen.getByText("reads zero across a full week").className).toContain("truncate");
  });
});
