import type { ClusterIndexRow, ClusterNodes } from "@repo/contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderInApp } from "~/test-utils";
import { IndexTable } from "./index-table";

// A Link outside a router throws on `isServer` rather than rendering, and what
// this file is about is the cells — so the anchor stands in for it, the way
// cluster-blocked.test.tsx does.
vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  const { anchorLink, overriding } = await import("~/lib/overriding");
  return overriding(actual, { Link: anchorLink });
});

function row(over: Partial<ClusterIndexRow> = {}): ClusterIndexRow {
  return {
    id: over.id ?? "11111111-1111-4111-8111-111111111111",
    database: "shop",
    collection: "orders",
    indexName: "status_1",
    keys: [{ field: "status", direction: 1 }],
    include: [],
    unique: false,
    ttl: false,
    partial: false,
    partialFilter: null,
    sparse: false,
    hidden: false,
    isShardKey: false,
    collation: null,
    hinted: false,
    sizeBytes: 4096,
    totalOps: 0,
    perMember: [],
    observedAt: "2026-08-01T00:00:00.000Z",
    recommendation: null,
    ...over,
  };
}

function roster(hosts: string[]): ClusterNodes {
  return {
    clusterId: "c1",
    collectedAt: "2026-08-01T00:00:00.000Z",
    nodes: hosts.map((host) => ({ host, role: "secondary" as const, state: "answered" as const })),
  };
}

function cellsOf(name: string): string[] {
  const cells = screen
    .getAllByRole("row")
    .slice(1)
    .find((tr) => tr.textContent?.includes(name));
  return [...(cells?.querySelectorAll("td") ?? [])].map((cell) => cell.textContent ?? "");
}

describe("IndexTable", () => {
  it("draws an index nothing has been proposed about, which is the point of the page", () => {
    renderInApp(
      <IndexTable
        clusterId="c1"
        indexes={[row()]}
        roster={null}
        engine="MONGODB"
        loading={false}
      />,
    );

    expect(screen.getByText("shop.orders")).toBeInTheDocument();
    expect(screen.getByText("status_1")).toBeInTheDocument();
    // The key pattern, which lived only inside a recommendation's rationale
    // before this page existed.
    expect(screen.getByText("status: 1")).toBeInTheDocument();
  });

  // The whole engine-neutrality requirement, in one assertion pair: `isShardKey`
  // is the port's "the cluster does not work without this" flag, and calling a
  // PostgreSQL primary key a shard key would be a MongoDB vocabulary applied to
  // an engine that has no shards.
  it("words the structural flag in the engine's own language", () => {
    const { unmount } = renderInApp(
      <IndexTable
        clusterId="c1"
        indexes={[row({ isShardKey: true })]}
        roster={null}
        engine="MONGODB"
        loading={false}
      />,
    );
    expect(screen.getByText("shard key")).toBeInTheDocument();
    unmount();

    renderInApp(
      <IndexTable
        clusterId="c1"
        indexes={[row({ isShardKey: true })]}
        roster={null}
        engine="POSTGRESQL"
        loading={false}
      />,
    );
    expect(screen.getByText("primary key")).toBeInTheDocument();
    expect(screen.queryByText("shard key")).not.toBeInTheDocument();
  });

  // A flag an engine cannot express is never drawn, because it is never set —
  // so the column carries badges rather than a row of "no"s with two engines'
  // blanks in it.
  it("draws nothing at all for an index with no flags", () => {
    renderInApp(
      <IndexTable
        clusterId="c1"
        indexes={[row()]}
        roster={null}
        engine="POSTGRESQL"
        loading={false}
      />,
    );
    expect(screen.queryByText("sparse")).not.toBeInTheDocument();
    expect(screen.queryByText("TTL")).not.toBeInTheDocument();
    expect(screen.queryByText("hidden")).not.toBeInTheDocument();
  });

  // Two states that were collected and never displayed, and which a customer
  // could previously only infer from a recommendation never appearing.
  it("shows a hidden index and one pinned by a hint", () => {
    renderInApp(
      <IndexTable
        clusterId="c1"
        indexes={[row({ hidden: true, hinted: true, unique: true })]}
        roster={null}
        engine="MONGODB"
        loading={false}
      />,
    );
    expect(screen.getByText("hidden")).toBeInTheDocument();
    expect(screen.getByText("hinted")).toBeInTheDocument();
    expect(screen.getByText("unique")).toBeInTheDocument();
  });

  // The rule the usage module exists for, applied here too: a member the collect
  // never reached is a blind spot of OURS, and folding it into the node ratio
  // would render it as the customer's.
  it("counts only the members that answered, and says how many did not", () => {
    renderInApp(
      <IndexTable
        clusterId="c1"
        indexes={[
          row({
            totalOps: 40,
            perMember: [{ member: "a:27017", ops: 40, since: "2026-07-01T00:00:00.000Z" }],
          }),
        ]}
        roster={roster(["a:27017", "b:27017", "c:27017"])}
        engine="MONGODB"
        loading={false}
      />,
    );

    // "1 of 1" — against the members that ANSWERED, never against the roster —
    // with the two we did not hear from counted separately.
    expect(screen.getByText(/40 ops · 1 of 1 node/)).toBeInTheDocument();
    expect(screen.getByText(/2 not reported/)).toBeInTheDocument();
  });

  it("links an index a live recommendation points at, and leaves the rest alone", () => {
    renderInApp(
      <IndexTable
        clusterId="c1"
        indexes={[
          row({
            id: "22222222-2222-4222-8222-222222222222",
            indexName: "linked_1",
            recommendation: {
              id: "33333333-3333-4333-8333-333333333333",
              type: "DROP_UNUSED",
              state: "PROPOSED",
            },
          }),
          row({ indexName: "quiet_1" }),
        ]}
        roster={null}
        engine="MONGODB"
        loading={false}
      />,
    );

    // The stand-in anchor keeps the route pattern rather than interpolating it;
    // what matters here is that the cell links at all, and only for the index a
    // recommendation names.
    expect(screen.getByRole("link", { name: "DROP_UNUSED" })).toHaveAttribute(
      "href",
      "/app/clusters/$clusterId",
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    // The unproposed index still has a row, and its last cell says so rather
    // than being blank.
    expect(cellsOf("quiet_1").at(-1)).toBe("—");
  });
});
