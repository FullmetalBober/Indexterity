import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type DashboardColumns, DataTable, dashboardColumns } from "~/components/data-table";
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
    expect(cols.map((col) => (col as HTMLElement).style.width)).toEqual(["300px", "96px"]);
    // And a floor, so narrow viewports scroll the columns instead of crushing them.
    expect(table?.style.minWidth).toBe("396px");
  });

  it("leaves a table that did not ask for widths in auto layout", () => {
    const { container } = renderVirtual();

    expect(container.querySelector("table")?.className ?? "").not.toContain("table-fixed");
    expect(container.querySelector("colgroup")).toBeNull();
  });
});
