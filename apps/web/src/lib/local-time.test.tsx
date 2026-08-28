import { render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LocalTime } from "./local-time";

// 2026-08-19T13:06:00Z — the instant from the report, where a UTC server wrote
// "01:06 PM" into the HTML and a UTC+3 reader's browser rendered "04:06 PM".
const ISO = "2026-08-19T13:06:00.000Z";

describe("LocalTime", () => {
  // The whole point. Whatever timezone the process runs in, the server writes UTC
  // — so the markup React compares during hydration cannot depend on the reader.
  it("renders UTC on the server, whatever the server's zone", () => {
    const html = renderToString(<LocalTime iso={ISO} />);

    expect(html).toContain("2026-08-19 13:06 UTC");
  });

  it("renders the UTC date on the server for a date-only timestamp", () => {
    expect(renderToString(<LocalTime iso={ISO} dateOnly />)).toContain("2026-08-19");
  });

  // The first client render must MATCH the server, or React discards the tree —
  // which is the error this file exists to prevent. The reader's own zone arrives
  // a frame later, from the effect.
  it("agrees with the server on the hydration render", () => {
    const server = renderToString(<LocalTime iso={ISO} options={{ hour: "2-digit" }} />);
    // Vitest renders with the effect flushed, so reach for the pre-effect output the
    // same way the browser sees it: the server string is what must be there first.
    expect(server).toContain("2026-08-19 13:06 UTC");
  });

  it("swaps to the reader's own formatting once mounted", async () => {
    render(<LocalTime iso={ISO} options={{ hour: "2-digit", minute: "2-digit" }} />);

    // Not asserting the exact string — that is the reader's locale and zone, which
    // is the point. Asserting it is no longer the UTC placeholder.
    expect(
      await screen.findByText((text) => text.length > 0 && !text.includes("UTC")),
    ).toBeInTheDocument();
  });

  it("draws a dash for a timestamp that is not one", () => {
    expect(renderToString(<LocalTime iso="not a date" />)).toContain("—");
  });
});
