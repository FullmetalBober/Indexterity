import type { CollectionStat, LatencySummary } from "@repo/contracts";
import { DeltaCell, fmtBytes, fmtMicros } from "~/components/app/format";
import { type DashboardColumns, DataTable, dashboardColumns } from "~/components/data-table";
import { Badge } from "~/components/ui/badge";

// One row per collection: the index footprint from the latest snapshot batch and
// the windowed latency summary, which are two different reads that answer one
// question. Either side can be missing — a collection can be measured for latency
// before its first index snapshot, and vice versa.
export interface CollectionRow {
  readonly ns: string;
  readonly stat: CollectionStat | null;
  readonly lat: LatencySummary | null;
}

// Merge the two by namespace. Lives here rather than in the route because it is
// the row shape's own business, and the route was doing it inline between a chart
// and a table.
export function toCollectionRows(
  collectionStats: readonly CollectionStat[],
  latency: readonly LatencySummary[],
): CollectionRow[] {
  const latencyByNs = new Map(latency.map((c) => [`${c.database}.${c.collection}`, c]));
  const statNs = new Set(collectionStats.map((c) => `${c.database}.${c.collection}`));
  return [
    ...collectionStats.map((stat) => {
      const ns = `${stat.database}.${stat.collection}`;
      return { ns, stat, lat: latencyByNs.get(ns) ?? null };
    }),
    ...latency
      .filter((c) => !statNs.has(`${c.database}.${c.collection}`))
      .map((lat) => ({ ns: `${lat.database}.${lat.collection}`, stat: null, lat })),
  ];
}

const column = dashboardColumns<CollectionRow>();

// A missing number sorts as -1 rather than as 0: "not measured" is not "zero
// bytes", and putting the unmeasured rows at one end keeps them out of the middle
// of a ranking they are not part of.
function orNull(value: number | null | undefined): number {
  return value ?? -1;
}

const columns: DashboardColumns<CollectionRow> = column.columns([
  column.accessor("ns", {
    header: "Collection",
    sortFn: "alphanumeric",
    cell: (info) => (
      // Truncated rather than wrapped: uniform row heights are what keep the
      // virtualizer's estimates honest, and a namespace is scanned by its tail as
      // often as its head — so the full value stays available on hover and to a
      // screen reader instead of being lost.
      <span className="block truncate font-mono text-xs" title={info.getValue()}>
        {info.getValue()}
      </span>
    ),
  }),
  column.accessor((row) => orNull(row.stat?.indexCount), {
    id: "indexCount",
    header: "Indexes",
    sortFn: "basic",
    sortDescFirst: true,
    cell: (info) => info.row.original.stat?.indexCount ?? "—",
  }),
  column.accessor((row) => orNull(row.stat?.totalIndexBytes), {
    id: "indexBytes",
    header: "Index size",
    sortFn: "basic",
    // The whole point of this column is finding the expensive collections, so
    // the first click puts the biggest at the top.
    sortDescFirst: true,
    cell: (info) => {
      const stat = info.row.original.stat;
      return stat === null ? "—" : fmtBytes(stat.totalIndexBytes);
    },
  }),
  column.accessor((row) => orNull(row.lat?.currentReadMicros), {
    id: "readMicros",
    header: "Read µs",
    sortFn: "basic",
    sortDescFirst: true,
    cell: (info) => fmtMicros(info.row.original.lat?.currentReadMicros ?? null),
  }),
  column.accessor((row) => orNull(row.lat?.readDeltaPct), {
    id: "readDelta",
    header: "Read Δ",
    sortFn: "basic",
    cell: (info) => <DeltaCell pct={info.row.original.lat?.readDeltaPct ?? null} />,
  }),
  column.accessor((row) => orNull(row.lat?.currentWriteMicros), {
    id: "writeMicros",
    header: "Write µs",
    sortFn: "basic",
    sortDescFirst: true,
    cell: (info) => fmtMicros(info.row.original.lat?.currentWriteMicros ?? null),
  }),
  column.accessor((row) => orNull(row.lat?.writeDeltaPct), {
    id: "writeDelta",
    header: "Write Δ",
    sortFn: "basic",
    cell: (info) => <DeltaCell pct={info.row.original.lat?.writeDeltaPct ?? null} />,
  }),
  column.accessor((row) => row.stat?.proposedRecommendations ?? 0, {
    id: "proposed",
    header: "Proposed",
    sortFn: "basic",
    sortDescFirst: true,
    cell: (info) =>
      info.getValue() > 0 ? (
        <Badge variant="secondary">{info.getValue()}</Badge>
      ) : (
        <span className="text-muted-foreground text-xs">—</span>
      ),
  }),
]);

export function CollectionsTable({ rows, loading }: { rows: CollectionRow[]; loading: boolean }) {
  return (
    <DataTable
      className="mt-2"
      caption="Per-collection index footprint and latency"
      columns={columns}
      data={rows}
      loading={loading}
      getRowId={(row) => row.ns}
      // Biggest index footprint first: this table exists to answer "where is the
      // space going", and the answer is at the top rather than found by scrolling.
      initialSorting={[{ id: "indexBytes", desc: true }]}
      filterLabel="Filter collections"
      // One row per collection, and getCollections applies no limit. Rows here are
      // single-line, so they estimate smaller than a recommendation's.
      virtualize={{ maxHeight: 560, estimateRowHeight: 44 }}
      // Collection, Indexes, Index size, Read µs, Read Δ, Write µs, Write Δ,
      // Proposed. The namespace gets the lion's share because it is the only column
      // holding something of unpredictable length — `msb-app.coach-reported-billing`
      // is not unusual — and everything after it is a short number under a header
      // that is wider than the value it labels.
      columnWidths={[340, 92, 116, 100, 92, 104, 92, 104]}
      // The namespace takes whatever the page has spare — a column holding "3" or "—"
      // gains nothing from being twice as wide. No ceiling on it any more: the 640px
      // cap kept the name near its numbers, and paid for that by leaving the table
      // short of the page it sits on, which is the more noticeable of the two.
      flexColumn={{ index: 0 }}
      empty={{
        title: "Nothing collected yet",
        description:
          "The footprint appears after the first collect, which runs every six hours from the moment a cluster is connected.",
      }}
    />
  );
}
