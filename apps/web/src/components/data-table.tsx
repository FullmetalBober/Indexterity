// The app's table: TanStack Table for the logic, shadcn's table primitives for
// the markup, one component for all three of them.
//
// The dashboard's tables were `<table>` markup with the rows mapped inline — no
// sorting, no filtering, and a header row whose column order had to be kept in
// step with the body's by hand. A cluster with fifty recommendations was a wall
// of rows in whatever order the api returned them.
//
// TanStack Table is headless, so none of this is a rewrite of the look: the same
// Table/TableRow/TableCell come out the other side. What changes is that a column
// is one object saying how to read the value, how to draw it and how to sort it,
// in one place instead of two.
import {
  type ColumnDef,
  columnFilteringFeature,
  createColumnHelper,
  createFilteredRowModel,
  createSortedRowModel,
  filterFn_includesString,
  globalFilteringFeature,
  type RowData,
  rowSortingFeature,
  type SortingState,
  sortFn_alphanumeric,
  sortFn_basic,
  sortFn_datetime,
  sortFn_text,
  tableFeatures,
  useTable,
} from "@tanstack/react-table";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";

// Declared once, statically, outside any component — which is what v9 asks for
// and is the point of its feature registry: what a table can do is settled at
// build time, so the grouping, pagination and row selection nobody here uses are
// not in the bundle. The three dashboard tables want the same three things, so
// there is one set rather than three.
//
// Only the sort functions a column actually names are registered. `basic` is the
// numeric one (scores, byte counts, percentages), `alphanumeric` orders
// namespaces with digits in them the way a reader expects (coll2 before coll10),
// `text` is plain strings, `datetime` is the audit trail's timestamps.
export const dashboardTableFeatures = tableFeatures({
  rowSortingFeature,
  columnFilteringFeature,
  globalFilteringFeature,
  sortedRowModel: createSortedRowModel(),
  filteredRowModel: createFilteredRowModel(),
  sortFns: {
    alphanumeric: sortFn_alphanumeric,
    basic: sortFn_basic,
    datetime: sortFn_datetime,
    text: sortFn_text,
  },
  filterFns: { includesString: filterFn_includesString },
});

export type DashboardTableFeatures = typeof dashboardTableFeatures;

// v9 types a column against the feature set it belongs to, so a helper cannot be
// made without naming that set. Each table calls this rather than importing
// createColumnHelper and repeating the type argument.
export function dashboardColumns<TData extends RowData>() {
  return createColumnHelper<DashboardTableFeatures, TData>();
}

// What a table hands over. Columns are built by the helper above, which is where
// the value types are exact; by the time they are a list they are only ever
// rendered, so the list is the erased form.
export type DashboardColumns<TData extends RowData> = Array<
  ColumnDef<DashboardTableFeatures, TData>
>;

interface DataTableProps<TData extends RowData> {
  // Both of these must be stable across renders — a fresh array each time
  // re-derives every row model, which is the one way to make a headless table
  // slower than the markup it replaced. Callers hold them in useMemo.
  readonly columns: DashboardColumns<TData>;
  readonly data: TData[];
  readonly getRowId: (row: TData) => string;
  // Where the reader wants to start, which is never "whatever the api returned".
  readonly initialSorting: SortingState;
  // Omitted = no filter box. Worth having only where the row count grows enough
  // to hunt through, which is all three of these on a real cluster.
  readonly filterLabel?: string;
  readonly empty: { readonly title: string; readonly description: ReactNode };
  // The table's accessible name. Each one sits under a heading that already says
  // what it is, so the caption is screen-reader-only rather than a second title.
  readonly caption: string;
  readonly className?: string;
}

export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  initialSorting,
  filterLabel,
  empty,
  caption,
  className,
}: DataTableProps<TData>) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting);
  const [globalFilter, setGlobalFilter] = useState("");

  const table = useTable({
    features: dashboardTableFeatures,
    columns,
    data,
    getRowId,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    // Clearing a sort would land the reader back on the api's arbitrary order,
    // which is not a state worth being able to reach; the toggle cycles asc/desc.
    enableSortingRemoval: false,
  });

  const rows = table.getRowModel().rows;

  // Empty because there is nothing, versus empty because the filter excluded
  // everything, are different facts and get different answers — the second one
  // is the reader's own query and they need to know that.
  if (data.length === 0) {
    return (
      <Empty className={className}>
        <EmptyHeader>
          <EmptyTitle>{empty.title}</EmptyTitle>
          <EmptyDescription>{empty.description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className={className}>
      {filterLabel === undefined ? null : (
        <div className="relative mb-2 max-w-xs">
          <SearchIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            aria-label={filterLabel}
            placeholder={filterLabel}
            className="pl-8"
            value={globalFilter}
            onChange={(event) => setGlobalFilter(event.target.value)}
          />
        </div>
      )}

      <Table>
        <TableCaption className="sr-only">{caption}</TableCaption>
        <TableHeader>
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id}>
              {group.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                return (
                  <TableHead key={header.id} aria-sort={ariaSort(sorted)}>
                    {header.column.getCanSort() ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-ml-2 h-7 px-2 text-muted-foreground has-[>svg]:px-2"
                        onClick={header.column.getToggleSortingHandler()}
                      >
                        <table.FlexRender header={header} />
                        <SortIcon sorted={sorted} />
                      </Button>
                    ) : (
                      <table.FlexRender header={header} />
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={table.getAllLeafColumns().length}
                className="h-20 text-center text-muted-foreground"
              >
                Nothing matches “{globalFilter}”.
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id}>
                {/* getAllCells, not getVisibleCells: that one belongs to
                    columnVisibilityFeature, and nothing here hides a column, so
                    registering the feature to call its getter would be paying for
                    it twice — in the bundle and in a name that promises a control
                    the reader does not have. */}
                {row.getAllCells().map((cell) => (
                  <TableCell key={cell.id}>
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

// Announced on the header cell, so a screen reader gets the sort state rather
// than having to infer it from an icon it cannot see.
function ariaSort(sorted: false | "asc" | "desc"): "ascending" | "descending" | "none" {
  if (sorted === "asc") return "ascending";
  if (sorted === "desc") return "descending";
  return "none";
}

function SortIcon({ sorted }: { sorted: false | "asc" | "desc" }) {
  if (sorted === "asc") return <ArrowUpIcon aria-hidden="true" />;
  if (sorted === "desc") return <ArrowDownIcon aria-hidden="true" />;
  return <ChevronsUpDownIcon aria-hidden="true" className="opacity-50" />;
}
