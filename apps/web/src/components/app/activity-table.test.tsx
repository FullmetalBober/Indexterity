import type { AuditAction } from "@repo/contracts";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderInApp } from "~/test-utils";
import { ActivityTable } from "./activity-table";

function entry(over: Partial<AuditAction> = {}): AuditAction {
  return {
    id: "a1",
    kind: "hide",
    actor: "engine",
    result: "ok",
    database: "shop",
    collection: "orders",
    indexName: "idx_a",
    createdAt: "2026-08-01T10:00:00.000Z",
    ...over,
  };
}

function opsInOrder(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelectorAll("td")[1]?.textContent ?? "");
}

describe("ActivityTable", () => {
  // Newest first is what a log means by sorted, and it is what the api happened
  // to return before — now it is stated rather than inherited.
  it("leads with the most recent operation", () => {
    renderInApp(
      <ActivityTable
        activity={[
          entry({ id: "old", kind: "build", createdAt: "2026-07-01T10:00:00.000Z" }),
          entry({ id: "new", kind: "drop", createdAt: "2026-08-05T10:00:00.000Z" }),
          entry({ id: "mid", kind: "hide", createdAt: "2026-08-01T10:00:00.000Z" }),
        ]}
      />,
    );

    expect(opsInOrder()).toEqual(["drop", "hide", "build"]);
  });

  it("orders oldest first when asked", async () => {
    const user = userEvent.setup();
    renderInApp(
      <ActivityTable
        activity={[
          entry({ id: "old", kind: "build", createdAt: "2026-07-01T10:00:00.000Z" }),
          entry({ id: "new", kind: "drop", createdAt: "2026-08-05T10:00:00.000Z" }),
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /When/ }));

    expect(opsInOrder()).toEqual(["build", "drop"]);
  });

  // The trail is capped at the latest 50 across every collection, so "what
  // happened to this index" is the question filtering exists to answer.
  it("filters down to one index's history", async () => {
    const user = userEvent.setup();
    renderInApp(
      <ActivityTable
        activity={[
          entry({ id: "1", kind: "hide", indexName: "idx_wanted" }),
          entry({ id: "2", kind: "drop", indexName: "idx_other" }),
        ]}
      />,
    );

    await user.type(screen.getByLabelText("Filter activity"), "idx_wanted");

    expect(opsInOrder()).toEqual(["hide"]);
  });

  it("filters by outcome, so the failures can be read on their own", async () => {
    const user = userEvent.setup();
    renderInApp(
      <ActivityTable
        activity={[
          entry({ id: "1", kind: "hide", result: "ok" }),
          entry({ id: "2", kind: "drop", result: "failed" }),
        ]}
      />,
    );

    await user.type(screen.getByLabelText("Filter activity"), "failed");

    expect(opsInOrder()).toEqual(["drop"]);
  });

  it("says the engine has changed nothing rather than drawing an empty grid", () => {
    renderInApp(<ActivityTable activity={[]} />);

    expect(screen.getByText("Nothing has been applied yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
});
