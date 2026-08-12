import type { ClusterCooldowns, ParkedIndex } from "@repo/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ParkedPanel } from "./parked-panel";

function entry(overrides: Partial<ParkedIndex> = {}): ParkedIndex {
  return {
    database: "shop",
    collection: "orders",
    indexName: "orders_customerId_1",
    reason: "read-latency regression during observe",
    regressionCount: 1,
    until: "2026-11-09T00:00:00.000Z",
    active: true,
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    ...overrides,
  };
}

function payload(parked: ParkedIndex[]): ClusterCooldowns {
  const active = parked.filter((row) => row.active);
  return {
    clusterId: "c1",
    activeCount: active.length,
    nextEligibleAt: active[active.length - 1]?.until ?? null,
    parked,
  };
}

describe("ParkedPanel", () => {
  // The sentence the panel exists to say (#159). Before it, a cluster with six
  // parked indexes and a clean one rendered identically.
  it("leads with how many are parked and when the next one is eligible", () => {
    render(
      <ParkedPanel
        cooldowns={payload([entry(), entry({ indexName: "orders_sku_1" })])}
        loading={false}
      />,
    );
    expect(screen.getByText("2 indexes parked")).toBeInTheDocument();
    expect(screen.getByText(/next eligible/)).toBeInTheDocument();
  });

  it("says index, not indexes, for one", () => {
    render(<ParkedPanel cooldowns={payload([entry()])} loading={false} />);
    expect(screen.getByText("1 index parked")).toBeInTheDocument();
  });

  // The count is the api's, computed against the api's clock. A browser an hour
  // behind must not be able to talk the headline out of what the server said.
  it("trusts the api's count over the rows it was sent", () => {
    render(<ParkedPanel cooldowns={{ ...payload([entry()]), activeCount: 4 }} loading={false} />);
    expect(screen.getByText("4 indexes parked")).toBeInTheDocument();
  });

  // The field with no other home in the product: one rejection is a proposal
  // that lost, three is a fact about the collection.
  it("names how many times an index has regressed", () => {
    render(<ParkedPanel cooldowns={payload([entry({ regressionCount: 3 })])} loading={false} />);
    expect(screen.getByText("regressed 3×")).toBeInTheDocument();
  });

  // Zero is the owner paths — recordManualVeto sets it deliberately, because
  // nothing regressed — so a "0×" badge would report a measurement nobody took.
  it("draws no regression badge for an owner's veto", () => {
    render(
      <ParkedPanel
        cooldowns={payload([entry({ regressionCount: 0, reason: "drop cancelled by an owner" })])}
        loading={false}
      />,
    );
    expect(screen.queryByText(/regressed/)).not.toBeInTheDocument();
    expect(screen.getByText("drop cancelled by an owner")).toBeInTheDocument();
  });

  // An expired cooldown is the only record that the index was ever parked — the
  // recommendation behind it is long gone — so it stays on screen, out of the
  // count and marked as back in scope.
  it("keeps expired cooldowns visible and out of the headline", () => {
    render(
      <ParkedPanel
        cooldowns={payload([
          entry(),
          entry({
            indexName: "orders_stale_1",
            active: false,
            until: "2026-01-04T00:00:00.000Z",
            regressionCount: 2,
          }),
        ])}
        loading={false}
      />,
    );
    expect(screen.getByText("1 index parked")).toBeInTheDocument();
    expect(screen.getByText(/eligible since/)).toBeInTheDocument();
    expect(screen.getByText("regressed 2×")).toBeInTheDocument();
  });

  // Everything expired: there is no next eligible date to name, and inventing
  // one would claim the engine is still holding back.
  it("says so when nothing is parked any more", () => {
    render(<ParkedPanel cooldowns={payload([entry({ active: false })])} loading={false} />);
    expect(screen.getByText("Nothing parked right now")).toBeInTheDocument();
    expect(screen.queryByText(/next eligible/)).not.toBeInTheDocument();
  });

  it("explains the empty state rather than drawing an empty list", () => {
    render(<ParkedPanel cooldowns={payload([])} loading={false} />);
    expect(screen.getByText("Nothing parked")).toBeInTheDocument();
  });
});
