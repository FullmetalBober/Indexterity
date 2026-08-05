import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
