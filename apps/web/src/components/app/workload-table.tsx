import type { WorkloadShape } from "@repo/contracts";
import type { ComponentProps } from "react";
import { fmtCount } from "~/components/app/format";
import { type DashboardColumns, DataTable, dashboardColumns } from "~/components/data-table";
import { Truncated } from "~/components/truncated";
import { Badge } from "~/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";

const column = dashboardColumns<WorkloadShape>();

// The ESR split as one line: what an index would have to cover, in the order it
// would have to cover it.
//
// Equality first, then sort, then range — the order that lets ONE index serve
// the whole query, and the reason the api sends the three lists rather than a
// flat key pattern: a reader who knows ESR can see straight away why the sort
// key sits where it does, and a reader who does not is told by the labels.
export function esrLine(shape: WorkloadShape): string {
  const parts = [
    ...shape.keys.equality.map((field) => field),
    ...shape.keys.sort.map((key) => (key.direction === -1 ? `${key.field}: -1` : key.field)),
    ...shape.keys.range.map((field) => `${field}: range`),
  ];
  return parts.length === 0 ? "(no indexable field)" : `{ ${parts.join(", ")} }`;
}

// The two failures, drawn separately because they ARE separate.
//
// A collection scan found no index at all. An in-memory sort found its documents
// through an index and could not order them — invisible to every scan test,
// since keys were examined, and the one that ends in an ERROR rather than in
// slowness: a blocking sort dies at 100 MB. A shape can be both.
function FailureCell({ shape }: { shape: WorkloadShape }) {
  return (
    <span className="flex flex-wrap gap-1">
      {shape.collscan ? (
        <Badge variant="destructive" title="No index was used at all — the server walked documents">
          scan
        </Badge>
      ) : null}
      {shape.sortedInMemory ? (
        <Badge
          variant="secondary"
          title="An index found the documents and could not order them, so the server sorted them in memory. This is the failure that ends in an error rather than in slowness — a blocking sort dies at 100 MB."
        >
          in-memory sort
        </Badge>
      ) : null}
    </span>
  );
}

const SEVERITY_TITLE: Readonly<Record<WorkloadShape["severity"], string>> = {
  CRITICAL: "10M+ documents walked, or 500k+ per execution — this is showing up in latency graphs",
  ELEVATED: "1M+ documents walked, or a large collection — worth prioritising",
  ROUTINE:
    "Below the tiers the engine escalates on. Grades the SCAN: an in-memory sort is routine by this measure and is not a small problem.",
};

// What happened, and why. The point of the page: an outcome other than
// `proposed` names the gate that declined, and the sentence beside it is the
// engine's own — composed server-side, because the counts mean nothing without
// the reason and the reason is a fact about the pipeline.
//
// A plain Tooltip rather than `Truncated`, deliberately. `Truncated` shows its
// tooltip only when the text did not fit, which is exactly right for a cell
// whose tooltip IS the rest of the cell — and exactly wrong here: the
// explanation is not the overflow of the word, it is the reason for it, and
// `proposed` is short enough to fit in any column. A reader would then be able
// to see why a shape was declined and not why one was acted on.
function OutcomeCell({ shape }: { shape: WorkloadShape }) {
  const proposed = shape.outcome === "proposed";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block cursor-help truncate">
          {proposed ? (
            <Badge variant="secondary">proposed</Badge>
          ) : (
            // The raw value, not the parsed one: an outcome this build does not
            // recognise renders as itself rather than as a blank.
            <span className="text-muted-foreground text-xs">{shape.outcomeRaw}</span>
          )}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm text-wrap">
        <span className="block whitespace-pre-line">
          {shape.explanation ??
            "Recorded by a newer version of the engine than the one answering this page, which is why there is no explanation for it here."}
          {shape.proposedIndex === null ? "" : `\n\nIndex: ${shape.proposedIndex}`}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

// How long this shape has been scanning. Same argument as the outcome cell for
// using a Tooltip: "12d ago" always fits, and the two dates behind it are the
// answer to whether this is a deploy regression or the way the application has
// always worked.
function FirstSeenCell({ shape }: { shape: WorkloadShape }) {
  const days = Math.floor((Date.now() - Date.parse(shape.firstSeenAt)) / 86_400_000);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="block cursor-help truncate text-muted-foreground text-xs">
          {days === 0 ? "today" : `${days}d ago`}
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-sm text-wrap">
        <span className="block whitespace-pre-line">
          {`first seen ${shape.firstSeenAt}\nlast seen ${shape.lastSeenAt}\nconfirmed by ${shape.observations} pass${shape.observations === 1 ? "" : "es"}`}
        </span>
      </TooltipContent>
    </Tooltip>
  );
}

const columns: DashboardColumns<WorkloadShape> = column.columns([
  column.accessor((row) => `${row.database}.${row.collection}`, {
    id: "namespace",
    header: "Collection",
    sortFn: "alphanumeric",
    cell: (info) => (
      <span className="block truncate font-mono text-xs" title={info.getValue()}>
        {info.getValue()}
      </span>
    ),
  }),
  column.accessor(esrLine, {
    id: "shape",
    header: "Index it needs",
    sortFn: "alphanumeric",
    cell: (info) => {
      const shape = info.row.original;
      return (
        <Truncated
          className="font-mono text-xs"
          full={
            <span className="block whitespace-pre-line font-mono">
              {[
                info.getValue(),
                shape.keys.equality.length === 0
                  ? null
                  : `equality: ${shape.keys.equality.join(", ")}`,
                shape.keys.sort.length === 0
                  ? null
                  : `sort: ${shape.keys.sort.map((key) => `${key.field} ${key.direction}`).join(", ")}`,
                shape.keys.range.length === 0 ? null : `range: ${shape.keys.range.join(", ")}`,
              ]
                .filter((line) => line !== null)
                .join("\n")}
            </span>
          }
        >
          {info.getValue()}
        </Truncated>
      );
    },
  }),
  column.accessor((row) => (row.collscan ? 2 : 0) + (row.sortedInMemory ? 1 : 0), {
    id: "failure",
    header: "Failure",
    sortFn: "basic",
    sortDescFirst: true,
    cell: (info) => <FailureCell shape={info.row.original} />,
  }),
  column.accessor("executions", {
    header: "Runs",
    sortFn: "basic",
    sortDescFirst: true,
    cell: (info) => fmtCount(info.getValue()),
  }),
  // The number the severity tiers actually measure, and the one this page is
  // ranked by. A missing figure is drawn as unknown rather than as zero: the
  // source could not say, which is not the same as "this costs nothing".
  column.accessor((row) => row.weeklyDocsExamined ?? -1, {
    id: "weeklyDocs",
    header: "Docs/week",
    sortFn: "basic",
    sortDescFirst: true,
    cell: (info) => {
      const weekly = info.row.original.weeklyDocsExamined;
      return weekly === null ? (
        <span
          className="text-muted-foreground text-xs"
          title="The workload source did not report examined documents — $queryStats reports them only from MongoDB 8.0"
        >
          not measured
        </span>
      ) : (
        fmtCount(weekly)
      );
    },
  }),
  column.accessor("severity", {
    header: "Severity",
    sortFn: "text",
    cell: (info) => (
      <Badge
        variant={info.getValue() === "CRITICAL" ? "destructive" : "outline"}
        title={SEVERITY_TITLE[info.getValue()]}
      >
        {info.getValue().toLowerCase()}
      </Badge>
    ),
  }),
  column.accessor(
    (row) =>
      row.clients.map((client) => client.application ?? client.driver ?? "unknown").join(", "),
    {
      id: "clients",
      header: "Clients",
      sortFn: "alphanumeric",
      cell: (info) =>
        info.getValue() === "" ? (
          <span className="text-muted-foreground text-xs">—</span>
        ) : (
          <Truncated className="text-xs">{info.getValue()}</Truncated>
        ),
    },
  ),
  column.accessor("outcome", {
    header: "Outcome",
    sortFn: "text",
    cell: (info) => <OutcomeCell shape={info.row.original} />,
  }),
  // First seen, not last: "is this new" is the question that decides whether a
  // scan is a deploy regression or the way this application has always worked,
  // and the create side had no history at all before this — recommendations are
  // deleted and re-proposed wholesale on every pass.
  column.accessor((row) => Date.parse(row.firstSeenAt), {
    id: "firstSeen",
    header: "First seen",
    sortFn: "basic",
    cell: (info) => <FirstSeenCell shape={info.row.original} />,
  }),
]);

export function WorkloadTable({
  shapes,
  loading,
  pagination,
}: {
  shapes: WorkloadShape[];
  loading: boolean;
  // Forwarded straight to the table, which owns the page arithmetic. Typed by
  // reading it off DataTable rather than restated, so a change there cannot
  // leave this signature quietly describing the old shape.
  pagination: NonNullable<ComponentProps<typeof DataTable>["pagination"]>;
}) {
  return (
    <DataTable
      className="mt-2"
      caption="Query shapes the server is working too hard to serve, and what the engine decided about each"
      columns={columns}
      data={shapes}
      loading={loading}
      getRowId={(row) => row.id}
      // The api already ranked them by weekly cost — the worst first is the
      // answer — so the initial sort agrees with the order the page arrived in
      // rather than re-ranking one page and calling it the cluster's worst.
      initialSorting={[{ id: "weeklyDocs", desc: true }]}
      pagination={pagination}
      filterLabel="Filter shapes"
      virtualize={{ maxHeight: 560, estimateRowHeight: 48 }}
      // Collection, Index it needs, Failure, Runs, Docs/week, Severity,
      // Clients, Outcome, First seen.
      columnWidths={[190, 260, 120, 80, 110, 100, 130, 140, 90]}
      // The shape absorbs the slack: it is the one column holding something of
      // genuinely unpredictable length.
      flexColumn={{ index: 1 }}
      empty={{
        title: "No scanning queries",
        description:
          "Every query the workload source reported reached its documents through an index. Create-side analysis runs hourly.",
      }}
    />
  );
}
