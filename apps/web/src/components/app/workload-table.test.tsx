import type { WorkloadShape } from "@repo/contracts";
import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderInApp } from "~/test-utils";
import { esrLine, WorkloadTable } from "./workload-table";

function shape(over: Partial<WorkloadShape> = {}): WorkloadShape {
  return {
    id: over.id ?? "11111111-1111-4111-8111-111111111111",
    database: "shop",
    collection: "orders",
    keys: { equality: ["status"], sort: [], range: [] },
    collscan: true,
    sortedInMemory: false,
    executions: 1200,
    docsExamined: 900_000,
    observedForHours: 168,
    weeklyDocsExamined: 900_000,
    severity: "ROUTINE",
    clients: [{ application: "checkout-api", driver: "nodejs" }],
    outcome: "below-cost-floor",
    outcomeRaw: "below-cost-floor",
    explanation: "This collection's scanning costs less than a million documents a week.",
    proposedIndex: null,
    firstSeenAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    lastSeenAt: new Date().toISOString(),
    observations: 72,
    ...over,
  };
}

describe("esrLine", () => {
  // Equality, then sort, then range — the order that lets ONE index serve the
  // whole query, and the reason the api sends three lists rather than a flat
  // key pattern.
  it("writes the ESR split in the order an index would have to cover it", () => {
    expect(
      esrLine(
        shape({
          keys: {
            equality: ["tenant", "status"],
            sort: [{ field: "created", direction: -1 }],
            range: ["total"],
          },
        }),
      ),
    ).toBe("{ tenant, status, created: -1, total: range }");
  });

  // A shape with nothing to put in a key prefix is the `no-candidate` outcome,
  // and the cell has to say so rather than render an empty `{ }`.
  it("says so when there is no indexable field", () => {
    expect(esrLine(shape({ keys: { equality: [], sort: [], range: [] } }))).toBe(
      "(no indexable field)",
    );
  });
});

// The pagination the route always supplies. One fixture spread into every render,
// describing a single page, which is the state that draws no page buttons and
// keeps these tests about the COLUMNS.
const paging = {
  pageIndex: 0,
  pageSize: 50,
  rowCount: 1,
  noun: "query shapes",
  onChange: () => undefined,
};

describe("WorkloadTable", () => {
  // The row that could not exist before #432: seen, priced, discarded, and now
  // on screen with the gate that discarded it.
  it("draws a shape nothing was proposed for, with the gate that declined it", () => {
    renderInApp(<WorkloadTable shapes={[shape()]} loading={false} pagination={paging} />);

    expect(screen.getByText("shop.orders")).toBeInTheDocument();
    expect(screen.getByText("{ status }")).toBeInTheDocument();
    expect(screen.getByText("below-cost-floor")).toBeInTheDocument();
  });

  // Two different failures, and the second is invisible to every scan test:
  // keys WERE examined, so by that measure the query looks healthy.
  it("tells a collection scan apart from an in-memory sort", () => {
    renderInApp(
      <WorkloadTable
        shapes={[
          shape({ collscan: true, sortedInMemory: false }),
          shape({
            id: "22222222-2222-4222-8222-222222222222",
            collscan: false,
            sortedInMemory: true,
          }),
        ]}
        loading={false}
        pagination={paging}
      />,
    );

    expect(screen.getByText("scan")).toBeInTheDocument();
    expect(screen.getByText("in-memory sort")).toBeInTheDocument();
  });

  // Unmeasured is not zero. `$queryStats` reports examined documents only from
  // MongoDB 8.0, and "0 docs/week" on a scan would be a measurement nobody took.
  it("draws an unreported weekly cost as unknown rather than as zero", () => {
    renderInApp(
      <WorkloadTable
        shapes={[shape({ weeklyDocsExamined: null, docsExamined: null })]}
        loading={false}
        pagination={paging}
      />,
    );

    expect(screen.getByText("not measured")).toBeInTheDocument();
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("compacts the big numbers this page exists for", () => {
    renderInApp(
      <WorkloadTable
        shapes={[shape({ executions: 12_481_003, weeklyDocsExamined: 43_200_000 })]}
        loading={false}
        pagination={paging}
      />,
    );

    expect(screen.getByText("12.5M")).toBeInTheDocument();
    expect(screen.getByText("43.2M")).toBeInTheDocument();
  });

  it("shows the proposed badge when an index was recommended", () => {
    renderInApp(
      <WorkloadTable
        shapes={[
          shape({
            outcome: "proposed",
            outcomeRaw: "proposed",
            proposedIndex: "status_1",
            explanation: "An index for this shape is on the recommendations table.",
          }),
        ]}
        loading={false}
        pagination={paging}
      />,
    );

    expect(screen.getByText("proposed")).toBeInTheDocument();
  });

  // The column is text so a new gate costs no migration, which means the value
  // can be one this build has never heard of. It renders as itself rather than
  // as a blank — the whole reason the column is text.
  it("renders an outcome it does not recognise verbatim", () => {
    renderInApp(
      <WorkloadTable
        shapes={[shape({ outcome: null, outcomeRaw: "some-future-gate", explanation: null })]}
        loading={false}
        pagination={paging}
      />,
    );

    expect(screen.getByText("some-future-gate")).toBeInTheDocument();
  });

  it("dates the shape from when it was FIRST seen, not last", () => {
    renderInApp(<WorkloadTable shapes={[shape()]} loading={false} pagination={paging} />);

    expect(screen.getByText("3d ago")).toBeInTheDocument();
  });

  // A client with no appName is a null on screen, not a missing field a reader
  // has to interpret — the driver's name is what is left to identify it by.
  it("falls back to the driver when a client reported no application name", () => {
    renderInApp(
      <WorkloadTable
        shapes={[shape({ clients: [{ application: null, driver: "nodejs" }] })]}
        loading={false}
        pagination={paging}
      />,
    );

    expect(screen.getByText("nodejs")).toBeInTheDocument();
  });
});
