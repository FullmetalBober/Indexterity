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
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon, SearchIcon } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "~/components/ui/empty";
import { Input } from "~/components/ui/input";
import { Skeleton } from "~/components/ui/skeleton";
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
  // The first fetch, with nothing cached — NOT a refetch. Without this the table
  // draws `empty` the moment `data` is the empty fallback, which is a claim
  // ("nothing has been applied here") made before the answer arrived (#72).
  //
  // Skeleton rows rather than a spinner, and inside the same header and
  // `<colgroup>` the real rows will land in, so the columns are already where
  // they are going to be. That is most of what makes a skeleton better than a
  // spinner: the page does not move underneath the reader when the data lands.
  readonly loading?: boolean;
  // The table's accessible name. Each one sits under a heading that already says
  // what it is, so the caption is screen-reader-only rather than a second title.
  readonly caption: string;
  readonly className?: string;
  // Set on the tables whose row count is bounded only by how big the customer is:
  // recommendations (collections × indexes) and the per-collection footprint. The
  // body gets its own scroll container and only the visible rows are in the DOM.
  //
  // `maxHeight` is a MAXIMUM, which is what keeps this from being a visible change
  // for everyone: a cluster with four collections renders at its natural height
  // with no scrollbar and looks exactly as it did. Only the long tail caps and
  // scrolls, and only the long tail was the problem.
  readonly virtualize?: { readonly maxHeight: number; readonly estimateRowHeight: number };
  // A width in px per leaf column, in order, rendered as a `<colgroup>` and paired
  // with `table-layout: fixed`.
  //
  // Not cosmetic — it is what stops a virtualized table shifting sideways as you
  // scroll it. `table-layout: auto` sizes each column from the rows currently in
  // the table, and virtualization means that is only ever the dozen or so rows in
  // view: scroll a long namespace into the window and the first column widens,
  // taking every column after it along for the ride. The row is doing nothing
  // wrong; the table is re-deciding its layout underneath the reader.
  //
  // It also settles the row heights, which the virtualizer measures. Widths that
  // move make cells re-wrap, so a row reports one height and later occupies
  // another, and `getTotalSize()` ends up describing a table that no longer
  // exists — the scroll range stops matching the content and the last rows become
  // unreachable.
  //
  // On a table narrower than their sum these are minimums, and the box scrolls.
  // Wider, and the slack goes to `flexColumn` alone, up to its stated maximum.
  //
  // They also make clipping the cells' job: a fixed column does not grow to fit, and
  // the primitive sets `whitespace-nowrap`, so anything longer than its column spills
  // straight over the next one — an index name landing on top of a count. Cells are
  // clipped here rather than at each column, because it is this prop that creates the
  // problem; a column holding something worth reading in full says so with `truncate`
  // and a title, which is the only way a clipped identifier stays recoverable.
  readonly columnWidths?: readonly number[];
  // Which column absorbs the space left over, as an index into columnWidths. Its own
  // number becomes a minimum rather than a width.
  //
  // Needed because `fixed` shares slack out in PROPORTION to the stated widths, which
  // on a wide page is the wrong answer for every column here: it left the columns
  // holding a single digit 250px wide while the namespace — the one that can actually
  // use the room — got no better treatment. A `<col>` with no width takes the whole
  // remainder under `fixed`, so naming one column is the whole mechanism.
  //
  // `max` is the other half, and leaving it out was its own bug: on a wide monitor the
  // namespace column ran to 1,800px and a collection's name ended up a long way from
  // its own numbers. A table does not have to be as wide as the page it sits on. Past
  // this the table stops growing and the leftover stays leftover — which the page
  // still spends well, on two charts side by side rather than on one stretched row.
  readonly flexColumn?: { readonly index: number; readonly max: number };
}

export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  initialSorting,
  filterLabel,
  empty,
  loading = false,
  caption,
  className,
  virtualize,
  columnWidths,
  flexColumn,
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

  // Rows are kept in the flow and bracketed by two spacer rows, rather than
  // absolutely positioned the way the virtualizer's own examples do it. That
  // matters twice over: a `<tr>` taken out of flow stops sharing the table's
  // column widths, so the columns lose alignment the moment you scroll — and it
  // stops being a row to a screen reader, which is most of what a `<table>` is
  // for. Two spacers of the right height buy the same DOM saving and cost the
  // table nothing.
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    // Only the opening guess. Every rendered row reports its real height back
    // through measureElement below, which it has to: a recommendation's score cell
    // grows a second line once a drop is scheduled, and its rationale is prose
    // that wraps to however many lines the window is wide.
    estimateSize: () => virtualize?.estimateRowHeight ?? 48,
    // Two screenfuls of rows either side of the window, derived rather than picked.
    //
    // Overscan is the whole answer to flicker while scrolling: rows outside the
    // window do not exist, so a scroll that outruns the next render paints the
    // spacer's empty space until React catches up. Eight rows was under half a
    // screenful here, which a trackpad flick clears in one gesture.
    //
    // Derived from the box and the row height because a constant would mean the
    // wrong thing the moment either changed — eight rows is a third of a screen in
    // the 44px-row collections table and half a screen in the 64px-row
    // recommendations one. Two screenfuls is a flick's worth of headroom, and costs
    // a few dozen `<tr>`s against a dataset of thousands.
    overscan: Math.ceil((2 * (virtualize?.maxHeight ?? 0)) / (virtualize?.estimateRowHeight ?? 48)),
    // The server has no scroll element to measure, and without a rect the
    // virtualizer reports a viewport of zero and renders no rows at all — which
    // is the SSR failure the raw-HTML e2e test exists to catch. Handing it the
    // container's own maximum gives the server a screenful to render, and the
    // client's first render agrees because it starts from the same number.
    initialRect: { width: 0, height: virtualize?.maxHeight ?? 0 },
    // Off for the tables that do not ask for it — the audit trail is capped at
    // fifty server-side, so it has no tail to virtualize.
    enabled: virtualize !== undefined,
  });

  const virtualRows = virtualize === undefined ? [] : virtualizer.getVirtualItems();
  const first = virtualRows[0];
  const last = virtualRows[virtualRows.length - 1];
  const padTop = first === undefined ? 0 : first.start;
  const padBottom = last === undefined ? 0 : virtualizer.getTotalSize() - last.end;
  const leafColumns = table.getAllLeafColumns();
  const columnCount = leafColumns.length;
  // The width the stated columns need, which is the table's floor and the base its
  // ceiling is measured from.
  const tableFloor = (columnWidths ?? []).reduce((total, width) => total + width, 0);

  // Empty because there is nothing, versus empty because the filter excluded
  // everything, are different facts and get different answers — the second one
  // is the reader's own query and they need to know that.
  //
  // And empty because we have not asked yet is a third: `loading` holds the
  // empty state back until it is true, rather than saying it early and taking
  // it back.
  if (!loading && data.length === 0) {
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
          {/* Drawn while loading, so the table does not shift down when it
              appears — but disabled, because a filter over rows that do not
              exist yet is a control that silently does nothing. */}
          <Input
            aria-label={filterLabel}
            placeholder={filterLabel}
            className="pl-8"
            disabled={loading}
            value={globalFilter}
            onChange={(event) => setGlobalFilter(event.target.value)}
          />
        </div>
      )}

      {/* The scroll container the virtualizer measures. Without `virtualize` there
          is no container at all and the table sits in the page flow as before.

          `overflow-visible` on the table primitive's own container is load-bearing.
          That primitive wraps every table in `overflow-x-auto`, so putting a
          scrolling box around it produced two nested scrollers: this one owning the
          vertical axis and that one the horizontal. The horizontal scrollbar then
          belongs to the FULL height of the table rather than to the screenful in
          view, so on a long table it sits hundreds of pixels below the fold — and a
          reader who cannot see the right-hand columns has no way to reach them that
          looks like scrolling. Flattening it to one box puts both scrollbars on the
          same viewport and keeps the sticky header stuck to the box actually being
          scrolled. */}
      <div
        ref={scrollRef}
        className={
          virtualize === undefined
            ? undefined
            : // `w-fit max-w-full` so the border hugs the table rather than the page. The
              // table stops at its own ceiling (see columnWidths/flexColumn) and a box
              // that kept going left a stretch of empty bordered space beside every
              // row. Capped at the parent so a narrow viewport still scrolls instead of
              // overflowing the page.
              "w-fit max-w-full overflow-auto rounded-md border [&_[data-slot=table-container]]:overflow-visible"
        }
        style={virtualize === undefined ? undefined : { maxHeight: virtualize.maxHeight }}
      >
        <Table
          className={columnWidths === undefined ? undefined : "table-fixed"}
          style={
            columnWidths === undefined
              ? undefined
              : // Below the floor the columns would be squeezed rather than scrolled,
                // and a namespace is not a thing to squeeze. The ceiling is that floor
                // with the flexible column grown to its maximum: wider than that, and
                // the only thing gained is distance between a row's name and its
                // numbers.
                {
                  minWidth: tableFloor,
                  maxWidth:
                    flexColumn === undefined
                      ? undefined
                      : tableFloor - (columnWidths[flexColumn.index] ?? 0) + flexColumn.max,
                }
          }
        >
          {columnWidths === undefined ? null : (
            <colgroup>
              {leafColumns.map((column, index) => (
                // Keyed by the column, not by its position: the widths are a
                // positional list, but a `<col>` stands for a real column and the
                // column has an id. Also what the lint rule is asking for, and it is
                // right — a positional key survives a reorder by describing the wrong
                // column rather than by failing.
                //
                // No width on the flexible one: that is what makes it take the whole
                // remainder rather than a proportional share of it.
                <col
                  key={column.id}
                  style={index === flexColumn?.index ? undefined : { width: columnWidths[index] }}
                />
              ))}
            </colgroup>
          )}
          <TableCaption className="sr-only">{caption}</TableCaption>
          {/* Sticky only when the body scrolls under it: a header that scrolls out
              of an inner container leaves the reader guessing which column is
              which, several hundred rows from the top. */}
          <TableHeader
            className={virtualize === undefined ? undefined : "sticky top-0 z-10 bg-background"}
          >
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
            {loading ? (
              <SkeletonRows columnCount={columnCount} />
            ) : rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columnCount} className="h-20 text-center text-muted-foreground">
                  Nothing matches “{globalFilter}”.
                </TableCell>
              </TableRow>
            ) : (
              <>
                <Spacer height={padTop} columnCount={columnCount} />
                {(virtualize === undefined
                  ? rows.map((row, index) => ({ row, index }))
                  : virtualRows.map((item) => ({ row: rows[item.index], index: item.index }))
                ).map(({ row, index }) =>
                  row === undefined ? null : (
                    <TableRow
                      key={row.id}
                      // Both are the virtualizer's contract for measuring a row it
                      // did not get to size itself: the ref reports the height, the
                      // index says which row was reported.
                      data-index={index}
                      ref={virtualize === undefined ? undefined : virtualizer.measureElement}
                    >
                      {/* getAllCells, not getVisibleCells: that one belongs to
                          columnVisibilityFeature, and nothing here hides a column,
                          so registering the feature to call its getter would be
                          paying for it twice — in the bundle and in a name that
                          promises a control the reader does not have. */}
                      {row.getAllCells().map((cell) => (
                        <TableCell
                          key={cell.id}
                          className={columnWidths === undefined ? undefined : "overflow-hidden"}
                        >
                          <table.FlexRender cell={cell} />
                        </TableCell>
                      ))}
                    </TableRow>
                  ),
                )}
                <Spacer height={padBottom} columnCount={columnCount} />
              </>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

// How many rows to draw while the first fetch is out. A guess either way — the
// row count is exactly the thing not known yet — so it is small enough to read
// as "a table is coming" rather than as a count, and the same for every table so
// no reader learns to read it as one.
const SKELETON_ROWS = 6;

// The body while `loading`. Real rows and real cells, so the `<colgroup>` and
// the header above still decide the geometry, and the bars land where the values
// will. `aria-hidden` because they stand for content rather than being any — a
// screen reader is told nothing rather than told six blank rows exist.
function SkeletonRows({ columnCount }: { columnCount: number }) {
  return (
    <>
      {Array.from({ length: SKELETON_ROWS }, (_, row) => (
        <TableRow
          // Positional is the honest key here: these rows stand for nothing, so
          // there is no identity to key them by, and the list never reorders.
          // biome-ignore lint/suspicious/noArrayIndexKey: placeholder rows have no identity
          key={row}
          aria-hidden="true"
          className="hover:bg-transparent"
        >
          {Array.from({ length: columnCount }, (_, cell) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholder cells have no identity
            <TableCell key={cell}>
              {/* min-w so a column with no stated width still has something to
                  size itself from: without one, `w-full` inside an auto-layout
                  table measures a zero-width child and the column collapses. */}
              <Skeleton className="h-4 w-full min-w-16" />
            </TableCell>
          ))}
        </TableRow>
      ))}
    </>
  );
}

// The height the rows above or below the window would have taken. A real row so
// the table's own layout keeps working, hidden from assistive tech because it
// stands for content rather than being any.
function Spacer({ height, columnCount }: { height: number; columnCount: number }) {
  if (height <= 0) return null;
  return (
    <TableRow aria-hidden="true" className="border-0 hover:bg-transparent">
      <TableCell colSpan={columnCount} className="p-0" style={{ height }} />
    </TableRow>
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
