import type { AuditAction } from "@repo/contracts";
import { useMemo } from "react";
import { type DashboardColumns, DataTable, dashboardColumns } from "~/components/data-table";
import { Badge } from "~/components/ui/badge";
import { formatTimestamp, useMounted } from "~/lib/hydration";

const column = dashboardColumns<AuditAction>();

// `mounted` is threaded through the columns because a timestamp cannot be
// formatted to the reader's locale during SSR — the server does not know it, and
// rendering one anyway is a guaranteed hydration mismatch (D20). So the columns
// are built per render of this component rather than once at module scope.
function buildColumns(mounted: boolean): DashboardColumns<AuditAction> {
  return column.columns([
    column.accessor("createdAt", {
      header: "When",
      sortFn: "datetime",
      // Newest first is what a log means by "sorted", so the first click on an
      // already-descending column should not quietly reverse it into oldest-first.
      sortDescFirst: true,
      cell: (info) => (
        <span className="whitespace-nowrap text-muted-foreground text-xs">
          {formatTimestamp(info.getValue(), mounted)}
        </span>
      ),
    }),
    column.accessor("kind", {
      header: "Op",
      sortFn: "text",
      cell: (info) => <Badge variant="outline">{info.getValue()}</Badge>,
    }),
    column.accessor((entry) => `${entry.database}.${entry.collection} · ${entry.indexName}`, {
      id: "target",
      header: "Index",
      sortFn: "alphanumeric",
      cell: (info) => <span className="font-mono text-xs">{info.getValue()}</span>,
    }),
    column.accessor("actor", {
      header: "Actor",
      sortFn: "text",
      cell: (info) => <span className="text-muted-foreground text-xs">{info.getValue()}</span>,
    }),
    column.accessor("result", {
      header: "Result",
      sortFn: "text",
      cell: (info) => <span className="text-muted-foreground text-xs">{info.getValue()}</span>,
    }),
  ]);
}

export function ActivityTable({ activity }: { activity: AuditAction[] }) {
  const mounted = useMounted();
  const columns = useMemo(() => buildColumns(mounted), [mounted]);

  return (
    <DataTable
      className="mt-2"
      caption="Every executed operation and its outcome"
      columns={columns}
      data={activity}
      getRowId={(entry) => entry.id}
      initialSorting={[{ id: "createdAt", desc: true }]}
      // The one table where filtering earns its place immediately: the trail is
      // capped at the latest 50 operations across every collection, so "what
      // happened to this index" is otherwise a manual scan.
      filterLabel="Filter activity"
      empty={{
        title: "Nothing has been applied yet",
        description:
          "Every hide, build, drop and rollback is recorded here as it happens. An empty trail means the engine has not changed anything on this cluster.",
      }}
    />
  );
}
