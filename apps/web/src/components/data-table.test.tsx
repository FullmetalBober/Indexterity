import type { SortingState } from "@tanstack/react-table";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type DashboardColumns,
  DataTable,
  dashboardColumns,
  pageWindow,
} from "~/components/data-table";
import { renderInApp } from "~/test-utils";

interface Row {
  readonly id: string;
  readonly name: string;
  readonly size: number;
}

const column = dashboardColumns<Row>();

// A string column and a number column in one list, which is the case that
// needs column.columns() to keep both value types.
const columns: DashboardColumns<Row> = column.columns([
  column.accessor("name", { header: "Name", sortFn: "alphanumeric" }),
  column.accessor("size", { header: "Size", sortFn: "basic", sortDescFirst: true }),
]);

const ROWS: Row[] = [
  { id: "a", name: "orders", size: 30 },
  { id: "b", name: "users", size: 10 },
  { id: "c", name: "events", size: 20 },
];

function render(rows: Row[] = ROWS) {
  return renderInApp(
    <DataTable
      caption="Test rows"
      columns={columns}
      data={rows}
      getRowId={(row) => row.id}
      initialSorting={[{ id: "name", desc: false }]}
      filterLabel="Filter rows"
      empty={{ title: "Nothing here", description: "Not collected yet." }}
    />,
  );
}

// The first column of every body row, top to bottom — the order under test.
function namesInOrder(): string[] {
  return screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.querySelectorAll("td")[0]?.textContent ?? "");
}

// Enough rows to exceed the shimmed 600px viewport at 40px each (see
// vitest.setup.ts), so a window is genuinely narrower than the data.
const MANY: Row[] = Array.from({ length: 500 }, (_, index) => ({
  id: `r${index}`,
  name: `coll-${String(index).padStart(3, "0")}`,
  size: index,
}));

function renderVirtual(rows: Row[] = MANY) {
  return renderInApp(
    <DataTable
      caption="Test rows"
      columns={columns}
      data={rows}
      getRowId={(row) => row.id}
      initialSorting={[{ id: "name", desc: false }]}
      filterLabel="Filter rows"
      empty={{ title: "Nothing here", description: "Not collected yet." }}
      virtualize={{ maxHeight: 600, estimateRowHeight: 40 }}
    />,
  );
}

// getAllByRole skips anything aria-hidden, so the spacers are already excluded —
// which is worth knowing twice over: it is why namesInOrder above stays correct
// under virtualization, and it is the same reason a screen reader never counts a
// spacer as a row. Reaching them takes an explicit `{ hidden: true }`.
function dataRows(): HTMLElement[] {
  return screen.getAllByRole("row").slice(1);
}

// `col as HTMLElement` claimed every queried node was one. `instanceof` asks.
function asElement(node: unknown): HTMLElement {
  if (!(node instanceof HTMLElement)) throw new Error(`expected an element, got ${String(node)}`);
  return node;
}

describe("DataTable", () => {
  it("starts in the order the caller asked for, not the api's", () => {
    render();
    expect(namesInOrder()).toEqual(["events", "orders", "users"]);
  });

  it("reverses on a second click of the same header", async () => {
    const user = userEvent.setup();
    render();

    await user.click(screen.getByRole("button", { name: /Name/ }));
    expect(namesInOrder()).toEqual(["users", "orders", "events"]);

    await user.click(screen.getByRole("button", { name: /Name/ }));
    expect(namesInOrder()).toEqual(["events", "orders", "users"]);
  });

  // A third click used to be able to land back on "no sorting at all", which is
  // the api's arbitrary order — a state the reader cannot ask for on purpose.
  it("never cycles back to unsorted", async () => {
    const user = userEvent.setup();
    render();
    const header = screen.getByRole("button", { name: /Name/ });

    for (let click = 0; click < 3; click++) await user.click(header);

    expect(namesInOrder()).toEqual(["users", "orders", "events"]);
  });

  // Numbers have to sort as numbers. Sorted as text, 30 comes before 10 · 20.
  it("sorts a numeric column numerically, biggest first", async () => {
    const user = userEvent.setup();
    render();

    await user.click(screen.getByRole("button", { name: /Size/ }));

    expect(namesInOrder()).toEqual(["orders", "events", "users"]);
  });

  it("announces the sort state on the header cell", async () => {
    const user = userEvent.setup();
    render();
    const nameHeader = screen.getAllByRole("columnheader")[0];
    expect(nameHeader).toHaveAttribute("aria-sort", "ascending");

    await user.click(screen.getByRole("button", { name: /Size/ }));

    expect(screen.getAllByRole("columnheader")[0]).toHaveAttribute("aria-sort", "none");
    expect(screen.getAllByRole("columnheader")[1]).toHaveAttribute("aria-sort", "descending");
  });

  it("narrows to what matches the filter, across every column", async () => {
    const user = userEvent.setup();
    render();

    await user.type(screen.getByLabelText("Filter rows"), "user");

    expect(namesInOrder()).toEqual(["users"]);
  });

  // Nothing left because of the filter is the reader's own doing, and has to read
  // differently from nothing left because the api sent nothing.
  it("says the filter excluded everything, quoting what was typed", async () => {
    const user = userEvent.setup();
    render();

    await user.type(screen.getByLabelText("Filter rows"), "zzz");

    expect(screen.getByText(/Nothing matches/)).toBeInTheDocument();
    expect(screen.getByText(/zzz/)).toBeInTheDocument();
  });

  it("draws an empty state instead of a headed table with no rows", () => {
    render([]);

    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.getByText("Not collected yet.")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    // And no filter box for rows that do not exist.
    expect(screen.queryByLabelText("Filter rows")).not.toBeInTheDocument();
  });

  it("leaves out the filter box when the caller does not ask for one", () => {
    renderInApp(
      <DataTable
        caption="Test rows"
        columns={columns}
        data={ROWS}
        getRowId={(row) => row.id}
        initialSorting={[{ id: "name", desc: false }]}
        empty={{ title: "Nothing here", description: "Not collected yet." }}
      />,
    );
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
  });

  // The heading above each table already names it on screen, so the caption is
  // the accessible name rather than a second visible title.
  it("names the table for a screen reader without showing a second title", () => {
    render();
    expect(screen.getByRole("table")).toHaveAccessibleName("Test rows");
  });
});

describe("DataTable, virtualized", () => {
  // The whole point: 500 rows of data, a screenful of rows in the DOM.
  it("puts a window in the DOM, not the dataset", () => {
    renderVirtual();

    const rendered = dataRows().length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(MANY.length / 4);
  });

  // Sorting is over the row model, not the window — so the top of a 500-row table
  // has to be the real first row, not the first of whatever happened to be
  // rendered when the click landed.
  it("sorts the whole dataset, not the visible window", async () => {
    const user = userEvent.setup();
    renderVirtual();

    expect(namesInOrder()[0]).toBe("coll-000");
    await user.click(screen.getByRole("button", { name: /Name/ }));

    expect(namesInOrder()[0]).toBe("coll-499");
  });

  it("filters the whole dataset", async () => {
    const user = userEvent.setup();
    renderVirtual();

    await user.type(screen.getByLabelText("Filter rows"), "coll-317");

    expect(namesInOrder()).toEqual(["coll-317"]);
  });

  // The spacers stand in for the rows above and below the window. They must not be
  // rows to a screen reader, and they must span the table so the columns keep their
  // widths — a `<tr>` taken out of the flow is what loses column alignment.
  it("stands the skipped rows in with spacers that span every column", () => {
    renderVirtual();

    const spacers = screen
      .getAllByRole("row", { hidden: true })
      .filter((row) => row.getAttribute("aria-hidden") === "true");
    expect(spacers.length).toBeGreaterThan(0);
    for (const spacer of spacers) {
      const cell = spacer.querySelector("td");
      expect(cell).toHaveAttribute("colspan", "2");
    }
  });

  // The server has no element to measure, so without initialRect the virtualizer
  // reports a viewport of zero and renders no rows — which is how a virtualized
  // table silently stops being server-rendered. Proving the rows are in the HTML
  // is the only way to know initialRect is doing its job; the e2e SSR test cannot
  // see it, because the e2e cluster has no collected rows to draw.
  it("server-renders a screenful of rows", () => {
    const html = renderToString(
      <DataTable
        caption="Test rows"
        columns={columns}
        data={MANY}
        getRowId={(row) => row.id}
        initialSorting={[{ id: "name", desc: false }]}
        empty={{ title: "Nothing here", description: "Not collected yet." }}
        virtualize={{ maxHeight: 600, estimateRowHeight: 40 }}
      />,
    );

    expect(html).toContain("coll-000");
    // A window, not the dataset: the last row must not be there.
    expect(html).not.toContain("coll-499");
  });

  // Short tables are the common case and must look untouched: no scrollbar, no
  // spacers, every row present.
  it("leaves a short table alone", () => {
    renderVirtual(ROWS);

    expect(namesInOrder()).toEqual(["events", "orders", "users"]);
    expect(
      screen.getAllByRole("row", { hidden: true }).filter((r) => r.getAttribute("aria-hidden")),
    ).toHaveLength(0);
  });

  // ONE scroll container, not two.
  //
  // The table primitive wraps every table in its own `overflow-x-auto`, so putting
  // a vertical scroller around it left the two axes on different boxes: the
  // horizontal scrollbar belonged to the full height of the table rather than to
  // the screenful in view, which on a long table puts it hundreds of pixels below
  // the fold. A reader who cannot see the right-hand columns then has no gesture
  // that reaches them.
  it("does not leave a second scroll container inside the first", () => {
    const { container } = renderVirtual();

    const outer = container.querySelector("[style*='max-height']");
    expect(outer?.className).toContain("overflow-auto");
    // Flattened by a rule on the outer box rather than by forking the primitive,
    // which is what its data-slot is for.
    expect(outer?.className).toContain("[&_[data-slot=table-container]]:overflow-visible");
    expect(container.querySelector("[data-slot=table-container]")).not.toBeNull();
  });
});

// Widths are what stop a virtualized table shifting sideways as it scrolls:
// `table-layout: auto` sizes columns from the rows currently rendered, and under
// virtualization that is only ever the window. Scroll a long value into view and
// every column after it moves.
describe("DataTable, column widths", () => {
  it("fixes the layout and states each width once, in order", () => {
    const { container } = renderInApp(
      <DataTable
        caption="Test rows"
        columns={columns}
        data={MANY}
        getRowId={(row) => row.id}
        initialSorting={[{ id: "name", desc: false }]}
        empty={{ title: "Nothing here", description: "Not collected yet." }}
        virtualize={{ maxHeight: 600, estimateRowHeight: 40 }}
        columnWidths={[300, 96]}
      />,
    );

    const table = container.querySelector("table");
    expect(table?.className).toContain("table-fixed");
    // A colgroup, not per-cell widths: one declaration per column for the whole
    // table, which is the only place a width can be stated once and be believed by
    // rows that are not currently rendered.
    const cols = [...container.querySelectorAll("colgroup col")];
    expect(cols.map((col) => asElement(col).style.width)).toEqual(["300px", "96px"]);
    // And a floor, so narrow viewports scroll the columns instead of crushing them.
    expect(table?.style.minWidth).toBe("396px");
  });

  it("leaves a table that did not ask for widths in auto layout", () => {
    const { container } = renderVirtual();

    expect(container.querySelector("table")?.className ?? "").not.toContain("table-fixed");
    expect(container.querySelector("colgroup")).toBeNull();
  });

  // A flexible column with no `max` is the dashboard's two tables: fill the
  // container, and let the flexible column have the slack.
  //
  // Both halves are asserted because either alone breaks it. Without the box
  // stretching, `w-fit` shrink-to-fits a full-width table and `table-fixed`
  // collapses it to the sum of the stated columns; without dropping the ceiling
  // the table stops at that number however wide the page is. Measured in a
  // browser once — at a 2200px container this is 1508px against 2198px — since
  // jsdom lays nothing out and can only be asked what was declared.
  it("takes the whole container when the flexible column has no ceiling", () => {
    const { container } = renderInApp(
      <DataTable
        caption="Test rows"
        columns={columns}
        data={MANY}
        getRowId={(row) => row.id}
        initialSorting={[{ id: "name", desc: false }]}
        empty={{ title: "Nothing here", description: "Not collected yet." }}
        virtualize={{ maxHeight: 600, estimateRowHeight: 40 }}
        columnWidths={[300, 96]}
        flexColumn={{ index: 0 }}
      />,
    );

    const table = container.querySelector("table");
    expect(table?.style.maxWidth).toBe("");
    expect(table?.style.minWidth).toBe("396px");
    // The flexible column states no width, which is what makes `fixed` hand it
    // the remainder rather than sharing it out in proportion.
    const cols = [...container.querySelectorAll("colgroup col")];
    expect(cols.map((col) => asElement(col).style.width)).toEqual(["", "96px"]);
    expect(
      container.querySelector("[data-slot=table-container]")?.parentElement?.className,
    ).toContain("w-full");
  });

  it("still hugs the table when a ceiling is asked for", () => {
    const { container } = renderInApp(
      <DataTable
        caption="Test rows"
        columns={columns}
        data={MANY}
        getRowId={(row) => row.id}
        initialSorting={[{ id: "name", desc: false }]}
        empty={{ title: "Nothing here", description: "Not collected yet." }}
        virtualize={{ maxHeight: 600, estimateRowHeight: 40 }}
        columnWidths={[300, 96]}
        flexColumn={{ index: 0, max: 500 }}
      />,
    );

    // 396 floor, minus the flexible column's 300, plus its 500.
    expect(container.querySelector("table")?.style.maxWidth).toBe("596px");
    expect(
      container.querySelector("[data-slot=table-container]")?.parentElement?.className,
    ).toContain("w-fit");
  });
});

// The elision, which is the only part of the control with arithmetic in it.
describe("pageWindow", () => {
  // Under the window width every page is a button, so there is nothing to elide
  // and no reason to make a reader interpret one.
  it("lists every page when they all fit", () => {
    expect(pageWindow(0, 1)).toEqual([0]);
    expect(pageWindow(3, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  // First and last are always reachable: they are the two pages a browsing
  // reader most often wants, and the two an offset cursor can now actually jump
  // to (D133).
  it("always keeps the first and last page", () => {
    for (const index of [0, 5, 10, 20]) {
      const window = pageWindow(index, 21);
      expect(window[0]).toBe(0);
      expect(window.at(-1)).toBe(20);
    }
  });

  it("elides the middle around the current page", () => {
    expect(pageWindow(10, 21)).toEqual([0, "gap-start", 9, 10, 11, "gap-end", 20]);
  });

  it("clamps the window at both ends rather than running off them", () => {
    expect(pageWindow(0, 21)).toEqual([0, 1, 2, 3, "gap-end", 20]);
    expect(pageWindow(20, 21)).toEqual([0, "gap-start", 17, 18, 19, 20]);
  });

  // The property that matters most, because breaking it makes a page reachable
  // from nowhere: every drawn page number is contiguous with its neighbour or
  // separated by a gap standing for two or more.
  it("never draws a gap in place of a single page", () => {
    for (const count of [8, 9, 10, 11, 12, 21, 40]) {
      for (let index = 0; index < count; index += 1) {
        const window = pageWindow(index, count);
        const numbers = window.filter((entry): entry is number => typeof entry === "number");
        for (const [position, page] of numbers.entries()) {
          const previous = numbers[position - 1];
          if (previous === undefined) continue;
          const hidden = page - previous - 1;
          // Adjacent, or a gap that earns its place by hiding at least two.
          expect(hidden === 0 || hidden >= 2).toBe(true);
          if (hidden >= 2) {
            expect(window).toContain(position === 1 ? "gap-start" : "gap-end");
          }
        }
        // And the page the reader is on is always one of them.
        expect(numbers).toContain(index);
      }
    }
  });
});

// The footer. Only drawn with the prop, which is what keeps the two tables that
// page nothing exactly as they were.
describe("DataTable pagination", () => {
  function renderPaged(options: {
    pageIndex?: number;
    pageSize?: number;
    rowCount?: number;
    noun?: string;
    onChange?: (next: { pageIndex: number; pageSize: number }) => void;
    pageSizes?: readonly number[];
  }) {
    return renderInApp(
      <DataTable
        caption="Test rows"
        columns={columns}
        data={ROWS.slice(0, 2)}
        getRowId={(row) => row.id}
        initialSorting={[{ id: "name", desc: false }]}
        empty={{ title: "Nothing here", description: "Not collected yet." }}
        pagination={{
          pageIndex: options.pageIndex ?? 0,
          pageSize: options.pageSize ?? 2,
          rowCount: options.rowCount ?? 5,
          noun: options.noun ?? "rows",
          onChange: options.onChange ?? (() => undefined),
          ...(options.pageSizes === undefined ? {} : { pageSizes: options.pageSizes }),
        }}
      />,
    );
  }

  it("draws no footer without the prop", () => {
    render();
    expect(screen.queryByRole("navigation")).not.toBeInTheDocument();
  });

  // The range, not just the total: "1-2 of 5" is what tells a reader the table
  // in front of them is a window rather than everything.
  it("says which rows of how many this page holds", () => {
    renderPaged({ pageIndex: 0 });
    expect(screen.getByText(/1-2 of 5 rows/)).toBeInTheDocument();
  });

  // The last page is short, and saying "5-6 of 5" would be arithmetic leaking
  // through the copy.
  it("does not run the range past the total on a short last page", () => {
    renderPaged({ pageIndex: 2 });
    expect(screen.getByText(/5-5 of 5 rows/)).toBeInTheDocument();
  });

  // Three pages of two out of five rows: the count comes from rowCount, which is
  // the whole reason the api returns a total the page cannot compute for itself.
  it("derives the page buttons from the row count, not the rows in hand", () => {
    renderPaged({});
    expect(screen.getByRole("button", { name: "Page 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Page 3" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Page 4" })).not.toBeInTheDocument();
  });

  it("marks the current page for a reader who cannot see which is filled", () => {
    renderPaged({ pageIndex: 1 });
    expect(screen.getByRole("button", { name: "Page 2" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Page 1" })).not.toHaveAttribute("aria-current");
  });

  it("cannot step off either end", () => {
    renderPaged({ pageIndex: 0 });
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled();
  });

  it("reports the page the reader asked for", async () => {
    const seen: { pageIndex: number; pageSize: number }[] = [];
    renderPaged({ pageIndex: 0, onChange: (next) => seen.push(next) });
    await userEvent.click(screen.getByRole("button", { name: "Page 3" }));
    expect(seen).toEqual([{ pageIndex: 2, pageSize: 2 }]);
  });

  // v9 hands onPaginationChange an UPDATER, and setPageSize's updater also moves
  // the page index so the row at the top of the page stays in view. Both have to
  // survive the trip to the caller, which is the only thing the adapter does.
  it("reports a page size change with the recomputed index", async () => {
    const seen: { pageIndex: number; pageSize: number }[] = [];
    renderPaged({
      pageIndex: 2,
      pageSize: 2,
      rowCount: 20,
      pageSizes: [2, 10],
      onChange: (next) => seen.push(next),
    });
    await userEvent.click(screen.getByRole("combobox", { name: "rows per page" }));
    await userEvent.click(screen.getByRole("option", { name: "10 / page" }));
    // Row 5 was at the top of page 3 at two per page; at ten per page that row
    // is on page 1.
    expect(seen).toEqual([{ pageIndex: 0, pageSize: 10 }]);
  });

  // One offered size is not a choice, so the control is not drawn.
  it("offers no size control for a single size", () => {
    renderPaged({ pageSizes: [2] });
    expect(screen.queryByRole("combobox", { name: "rows per page" })).not.toBeInTheDocument();
  });

  // The caveat the control would otherwise imply away: it pages the SET and
  // sorts the PAGE, and those are different scopes.
  it("admits that sorting and filtering are page-scoped", () => {
    renderPaged({});
    expect(screen.getByText(/sorting and filtering apply to this page/)).toBeInTheDocument();
  });
});

// Server-owned sort and filter. The dimension the api owns must be REPORTED and
// not applied, or the table would reorder the rows the server chose and the
// header would describe a set nobody asked for (D135).
describe("DataTable server-owned sort and filter", () => {
  function renderManual(over: {
    sorting?: { state: SortingState; onChange: (next: SortingState) => void };
    filter?: { value: string; onChange: (next: string) => void };
  }) {
    return renderInApp(
      <DataTable
        caption="Test rows"
        columns={columns}
        data={ROWS}
        getRowId={(row) => row.id}
        initialSorting={[{ id: "name", desc: false }]}
        filterLabel="Filter rows"
        empty={{ title: "Nothing here", description: "Not collected yet." }}
        {...over}
      />,
    );
  }

  const names = () =>
    screen
      .getAllByRole("row")
      .slice(1)
      .map((tr) => tr.querySelector("td")?.textContent ?? "");

  // ROWS is orders/users/events — deliberately NOT alphabetical, so a table that
  // sorted locally would be visibly different from one that did not.
  it("leaves the api's row order alone", async () => {
    const seen: SortingState[] = [];
    renderManual({
      sorting: { state: [{ id: "name", desc: false }], onChange: (next) => seen.push(next) },
    });
    expect(names()).toEqual(["orders", "users", "events"]);

    await userEvent.click(screen.getByRole("button", { name: /^Name/ }));
    // Reported, not applied: the next render's rows are the api's answer.
    expect(seen).toEqual([[{ id: "name", desc: true }]]);
    expect(names()).toEqual(["orders", "users", "events"]);
  });

  it("still draws which column the api sorted by", () => {
    renderManual({
      sorting: { state: [{ id: "size", desc: true }], onChange: () => undefined },
    });
    // On the header CELL, which is where aria-sort belongs — the button inside it
    // is the control, not the sorted thing.
    expect(screen.getByRole("columnheader", { name: /Size/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
  });

  it("reports the filter without applying it", async () => {
    const seen: string[] = [];
    renderManual({ filter: { value: "", onChange: (next) => seen.push(next) } });
    await userEvent.type(screen.getByLabelText("Filter rows"), "ord");
    expect(seen.at(-1)).toBe("d");
    // Every row still drawn: the api decides what matches, and it has not answered.
    expect(names()).toHaveLength(ROWS.length);
  });

  // The value is the caller's, so a controlled box shows what the route holds
  // rather than its own copy.
  it("shows the filter value the caller holds", () => {
    renderManual({ filter: { value: "orders", onChange: () => undefined } });
    expect(screen.getByLabelText("Filter rows")).toHaveValue("orders");
  });

  // Without the props nothing changes, which is what protects the three capped
  // tables that sort and filter in the browser (D33).
  it("sorts and filters locally when the api owns neither", async () => {
    render();
    expect(names()).toEqual(["events", "orders", "users"]);
    await userEvent.type(screen.getByLabelText("Filter rows"), "ord");
    expect(names()).toEqual(["orders"]);
  });
});
