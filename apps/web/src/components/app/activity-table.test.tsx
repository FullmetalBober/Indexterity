import type { AuditAction } from "@repo/contracts";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "~/test-utils";
import { ActivityTable } from "./activity-table";

const rollbackRecommendation = vi.hoisted(() => vi.fn());

// The real client with the one call this table makes replaced, through the same
// forwarding Proxy the recommendations table's test uses — a call nobody set up
// fails instead of answering `undefined`.
vi.mock("~/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/api")>();
  const { overriding } = await import("~/lib/overriding");
  return {
    ...actual,
    api: () => overriding(actual.api(), { rollbackRecommendation }),
  };
});

function entry(over: Partial<AuditAction> = {}): AuditAction {
  return {
    id: "a1",
    recommendationId: "r1",
    kind: "hide",
    actor: "engine",
    result: "ok",
    database: "shop",
    collection: "orders",
    indexName: "idx_a",
    createdAt: "2026-08-01T10:00:00.000Z",
    undoable: false,
    ...over,
  };
}

beforeEach(() => {
  rollbackRecommendation.mockReset();
});

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
        clusterId="c1"
        activity={[
          entry({ id: "old", kind: "build", createdAt: "2026-07-01T10:00:00.000Z" }),
          entry({ id: "new", kind: "drop", createdAt: "2026-08-05T10:00:00.000Z" }),
          entry({ id: "mid", kind: "hide", createdAt: "2026-08-01T10:00:00.000Z" }),
        ]}
        loading={false}
      />,
    );

    expect(opsInOrder()).toEqual(["drop", "hide", "build"]);
  });

  it("orders oldest first when asked", async () => {
    const user = userEvent.setup();
    renderInApp(
      <ActivityTable
        clusterId="c1"
        activity={[
          entry({ id: "old", kind: "build", createdAt: "2026-07-01T10:00:00.000Z" }),
          entry({ id: "new", kind: "drop", createdAt: "2026-08-05T10:00:00.000Z" }),
        ]}
        loading={false}
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
        clusterId="c1"
        activity={[
          entry({ id: "1", kind: "hide", indexName: "idx_wanted" }),
          entry({ id: "2", kind: "drop", indexName: "idx_other" }),
        ]}
        loading={false}
      />,
    );

    await user.type(screen.getByLabelText("Filter activity"), "idx_wanted");

    expect(opsInOrder()).toEqual(["hide"]);
  });

  it("filters by outcome, so the failures can be read on their own", async () => {
    const user = userEvent.setup();
    renderInApp(
      <ActivityTable
        clusterId="c1"
        activity={[
          entry({ id: "1", kind: "hide", result: "ok" }),
          entry({ id: "2", kind: "drop", result: "failed" }),
        ]}
        loading={false}
      />,
    );

    await user.type(screen.getByLabelText("Filter activity"), "failed");

    expect(opsInOrder()).toEqual(["drop"]);
  });

  it("says the engine has changed nothing rather than drawing an empty grid", () => {
    renderInApp(<ActivityTable clusterId="c1" activity={[]} loading={false} />);

    expect(screen.getByText("Nothing has been applied yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  // "The engine has not changed anything on this cluster" is a claim, and it
  // used to be made from an empty array that only meant the read was still out
  // (#72). An empty trail and an unanswered one are not the same sentence.
  it("does not claim the engine changed nothing while the read is still out", () => {
    renderInApp(<ActivityTable clusterId="c1" activity={[]} loading={true} />);

    expect(screen.queryByText("Nothing has been applied yet")).not.toBeInTheDocument();
    // The header is drawn, so the columns are already where the rows will land.
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /When/ })).toBeInTheDocument();
    // And the filter is there but inert — a box that silently matches nothing
    // is worse than one that says it cannot be used yet.
    expect(screen.getByLabelText("Filter activity")).toBeDisabled();
  });

  // The open recommendations list no longer carries dropped indexes (#606), so a
  // drop is undone from its own row — and only where the api says it still can be.
  it("offers undo only on a drop that can still be undone", () => {
    renderInApp(
      <ActivityTable
        clusterId="c1"
        activity={[
          entry({ id: "1", kind: "HIDE" }),
          entry({ id: "2", kind: "DROP", undoable: true }),
          entry({ id: "3", kind: "DROP", indexName: "idx_undone" }),
        ]}
        loading={false}
      />,
    );

    expect(screen.getAllByRole("button", { name: "Undo" })).toHaveLength(1);
  });

  it("rebuilds through the drop's recommendation when confirmed", async () => {
    const user = userEvent.setup();
    rollbackRecommendation.mockResolvedValue({});
    renderInApp(
      <ActivityTable
        clusterId="c1"
        activity={[entry({ id: "a5", recommendationId: "r5", kind: "DROP", undoable: true })]}
        loading={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Undo" }));
    const dialog = within(await screen.findByRole("alertdialog"));
    await user.click(dialog.getByRole("button", { name: "Rebuild" }));

    expect(rollbackRecommendation).toHaveBeenCalledWith({ id: "r5" });
  });
});
