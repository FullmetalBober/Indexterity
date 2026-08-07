import type { CollectionStat, LatencySummary } from "@repo/contracts";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderInApp } from "~/test-utils";
import { CollectionsTable, toCollectionRows } from "./collections-table";

function stat(over: Partial<CollectionStat> = {}): CollectionStat {
  return {
    database: "shop",
    collection: "orders",
    indexCount: 3,
    totalIndexBytes: 2048,
    proposedRecommendations: 0,
    ...over,
  };
}

function lat(over: Partial<LatencySummary> = {}): LatencySummary {
  return {
    database: "shop",
    collection: "orders",
    samples: 10,
    currentReadMicros: 100,
    baselineReadMicros: 200,
    readDeltaPct: -50,
    currentWriteMicros: 80,
    baselineWriteMicros: 80,
    writeDeltaPct: 0,
    ...over,
  };
}

function namespacesInOrder(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelectorAll("td")[0]?.textContent ?? "");
}

describe("toCollectionRows", () => {
  it("pairs the footprint with the latency for the same namespace", () => {
    const rows = toCollectionRows([stat()], [lat()]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.ns).toBe("shop.orders");
    expect(rows[0]?.stat).not.toBeNull();
    expect(rows[0]?.lat).not.toBeNull();
  });

  // The two reads are independent, so either side can arrive first. A collection
  // measured for latency but not yet snapshotted still deserves a row.
  it("keeps a latency-only collection, with no footprint", () => {
    const rows = toCollectionRows([], [lat({ collection: "events" })]);

    expect(rows.map((row) => row.ns)).toEqual(["shop.events"]);
    expect(rows[0]?.stat).toBeNull();
  });

  it("keeps a footprint-only collection, with no latency", () => {
    const rows = toCollectionRows([stat({ collection: "carts" })], []);

    expect(rows.map((row) => row.ns)).toEqual(["shop.carts"]);
    expect(rows[0]?.lat).toBeNull();
  });

  it("does not list a namespace twice when both reads have it", () => {
    const rows = toCollectionRows(
      [stat({ collection: "a" }), stat({ collection: "b" })],
      [lat({ collection: "b" }), lat({ collection: "c" })],
    );

    expect(rows.map((row) => row.ns)).toEqual(["shop.a", "shop.b", "shop.c"]);
  });
});

describe("CollectionsTable", () => {
  // The table's job is answering "where is the space going", so the biggest
  // footprint is at the top before anyone clicks anything.
  it("leads with the largest index footprint", () => {
    renderInApp(
      <CollectionsTable
        rows={toCollectionRows(
          [
            stat({ collection: "small", totalIndexBytes: 1024 }),
            stat({ collection: "big", totalIndexBytes: 9_000_000 }),
            stat({ collection: "mid", totalIndexBytes: 500_000 }),
          ],
          [],
        )}
        loading={false}
      />,
    );

    expect(namespacesInOrder()).toEqual(["shop.big", "shop.mid", "shop.small"]);
  });

  // "Not measured" is not "zero". Sorting an unmeasured collection as 0 would
  // rank it alongside a genuinely idle one, which is a different fact.
  it("keeps unmeasured collections out of the middle of a ranking", async () => {
    const user = userEvent.setup();
    renderInApp(
      <CollectionsTable
        rows={toCollectionRows(
          [stat({ collection: "measured" }), stat({ collection: "unmeasured" })],
          [lat({ collection: "measured", currentReadMicros: 5 })],
        )}
        loading={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /Read µs/ }));

    // Descending: the measured 5 outranks the unmeasured dash.
    expect(namespacesInOrder()).toEqual(["shop.measured", "shop.unmeasured"]);
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("filters by namespace", async () => {
    const user = userEvent.setup();
    renderInApp(
      <CollectionsTable
        rows={toCollectionRows([stat({ collection: "orders" }), stat({ collection: "users" })], [])}
        loading={false}
      />,
    );

    await user.type(screen.getByLabelText("Filter collections"), "users");

    expect(namespacesInOrder()).toEqual(["shop.users"]);
  });

  it("says what is coming instead of showing an empty grid", () => {
    renderInApp(<CollectionsTable rows={[]} loading={false} />);

    expect(screen.getByText("Nothing collected yet")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  // "Nothing collected yet. The footprint appears after the first collect" tells
  // a reader their cluster has never been collected — which the page did not
  // know yet (#72).
  it("does not say a cluster was never collected while the read is still out", () => {
    renderInApp(<CollectionsTable rows={[]} loading={true} />);

    expect(screen.queryByText("Nothing collected yet")).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByLabelText("Filter collections")).toBeDisabled();
  });
});
