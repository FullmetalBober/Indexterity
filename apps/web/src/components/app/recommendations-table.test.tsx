import type { Recommendation } from "@repo/contracts";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderInApp } from "~/test-utils";
import { RecommendationsTable } from "./recommendations-table";

const approveRecommendation = vi.hoisted(() => vi.fn());
const unhideRecommendation = vi.hoisted(() => vi.fn());
const rollbackRecommendation = vi.hoisted(() => vi.fn());

vi.mock("~/lib/api", () => ({
  api: () => ({ approveRecommendation, unhideRecommendation, rollbackRecommendation }),
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function rec(over: Partial<Recommendation> = {}): Recommendation {
  return {
    id: "r1",
    clusterId: "c1",
    type: "DROP_UNUSED",
    usageClass: "FLAT_ZERO",
    state: "PROPOSED",
    database: "shop",
    collection: "orders",
    indexName: "idx_a",
    rationale: "no reads in 30 days",
    score: 50,
    estimatedBytesSaved: 1024,
    hiddenAt: null,
    observeDays: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...over,
  };
}

// Every body row's index-name cell, top to bottom.
function indexesInOrder(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelectorAll("td")[2]?.textContent ?? "");
}

beforeEach(() => {
  approveRecommendation.mockResolvedValue(rec());
  unhideRecommendation.mockResolvedValue(rec());
  rollbackRecommendation.mockResolvedValue(rec());
});

describe("RecommendationsTable", () => {
  // A cluster with fifty of these was ordered by whatever the api returned. The
  // one ordering worth defaulting to is the engine's own confidence.
  it("leads with the highest score", () => {
    renderInApp(
      <RecommendationsTable
        clusterId="c1"
        recommendations={[
          rec({ id: "low", indexName: "idx_low", score: 20 }),
          rec({ id: "high", indexName: "idx_high", score: 90 }),
          rec({ id: "mid", indexName: "idx_mid", score: 55 }),
        ]}
        loading={false}
      />,
    );

    expect(indexesInOrder()).toEqual(["idx_high", "idx_mid", "idx_low"]);
  });

  // Namespaces sort as one value, so a collection's indexes stay together instead
  // of being interleaved with every other database's.
  it("sorts by namespace as a whole, digits in reader order", async () => {
    const user = userEvent.setup();
    renderInApp(
      <RecommendationsTable
        clusterId="c1"
        recommendations={[
          rec({ id: "1", collection: "shard10", indexName: "idx_ten" }),
          rec({ id: "2", collection: "shard2", indexName: "idx_two" }),
        ]}
        loading={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Collection/ }));

    expect(indexesInOrder()).toEqual(["idx_two", "idx_ten"]);
  });

  it("filters across the namespace and the rationale, not just one column", async () => {
    const user = userEvent.setup();
    renderInApp(
      <RecommendationsTable
        clusterId="c1"
        recommendations={[
          rec({ id: "1", collection: "orders", indexName: "idx_orders" }),
          rec({ id: "2", collection: "users", indexName: "idx_users", rationale: "redundant" }),
        ]}
        loading={false}
      />,
    );

    await user.type(screen.getByLabelText("Filter recommendations"), "redundant");

    expect(indexesInOrder()).toEqual(["idx_users"]);
  });

  it("offers approve on a proposal, and sends the id when confirmed", async () => {
    const user = userEvent.setup();
    renderInApp(
      <RecommendationsTable clusterId="c1" recommendations={[rec({ id: "r9" })]} loading={false} />,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    // Scoped to the dialog: the trigger says "Approve" too, and confirming from
    // inside is the click that has to reach the api.
    const dialog = within(await screen.findByRole("alertdialog"));
    await user.click(dialog.getByRole("button", { name: "Approve" }));

    expect(approveRecommendation).toHaveBeenCalledWith({ id: "r9" });
  });

  // Each state offers exactly one thing, and an advisory offers none — the engine
  // will not act on those at any setting, so a button would be a lie.
  it.each([
    ["PROPOSED", "Approve"],
    ["HIDDEN", "Keep it"],
    ["DROPPED", "Undo"],
  ] as const)("offers %s the %s action", (state, label) => {
    renderInApp(
      <RecommendationsTable
        clusterId="c1"
        recommendations={[rec({ state, hiddenAt: null })]}
        loading={false}
      />,
    );
    expect(screen.getByRole("button", { name: label })).toBeInTheDocument();
  });

  it("offers nothing on an advisory", () => {
    renderInApp(
      <RecommendationsTable
        clusterId="c1"
        recommendations={[rec({ type: "ADVISORY_REVIEW" })]}
        loading={false}
      />,
    );

    expect(screen.getByText("review manually")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
  });

  it("says when a hidden index is due to be dropped, since the score no longer decides", () => {
    const soon = new Date(Date.now() + 5 * 86_400_000).toISOString();
    renderInApp(
      <RecommendationsTable
        clusterId="c1"
        recommendations={[rec({ state: "HIDDEN", hiddenAt: soon, observeDays: 1 })]}
        loading={false}
      />,
    );

    expect(screen.getByText(/^drops /)).toBeInTheDocument();
  });

  it("explains an empty table rather than drawing headers over nothing", () => {
    renderInApp(<RecommendationsTable clusterId="c1" recommendations={[]} loading={false} />);

    expect(screen.getByText("No recommendations yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  // The worst of the three empty states, because the last sentence of it —
  // "nothing to review means nothing is obviously wrong" — is a safety claim,
  // and it was being made about clusters with forty proposals in flight (#72).
  it("withholds the safety claim until the read has answered", () => {
    renderInApp(<RecommendationsTable clusterId="c1" recommendations={[]} loading={true} />);

    expect(screen.queryByText("No recommendations yet")).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter recommendations")).toBeDisabled();
  });
});
