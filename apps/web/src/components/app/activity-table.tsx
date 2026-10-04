import type { AuditAction } from "@repo/contracts";
import { useMemo } from "react";
import { ConfirmButton } from "~/components/confirm-button";
import { type DashboardColumns, DataTable, dashboardColumns } from "~/components/data-table";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { formatTimestamp, useMounted } from "~/lib/hydration";
import { useRollbackRecommendation } from "~/lib/queries/mutations/recommendations";

const column = dashboardColumns<AuditAction>();

// `mounted` is threaded through the columns because a timestamp cannot be
// formatted to the reader's locale during SSR — the server does not know it, and
// rendering one anyway is a guaranteed hydration mismatch (D20). So the columns
// are built per render of this component rather than once at module scope.
//
// `undo` by its `mutate` rather than as the mutation object, for the reason the
// recommendations table gives: react-query keeps `mutate` stable across renders,
// so the columns are not rebuilt on every keystroke in the filter box.
function buildColumns(
  mounted: boolean,
  undo: (recommendationId: string) => void,
): DashboardColumns<AuditAction> {
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
    // The one thing a past operation still offers. The open recommendations list
    // no longer carries dropped indexes (#606), so the drop's own row is where it
    // is undone — and only while the api says it can be: a drop already undone, or
    // one that recorded no spec to rebuild from, offers nothing.
    column.display({
      id: "undo",
      header: "Undo",
      cell: (info) => {
        const entry = info.row.original;
        if (!entry.undoable) return null;
        return (
          <ConfirmButton
            trigger={
              <Button size="sm" variant="outline">
                Undo
              </Button>
            }
            title={`Rebuild ${entry.indexName}?`}
            description="The index is recreated from the spec recorded at drop time, and the ROI headline is corrected back down."
            confirmLabel="Rebuild"
            onConfirm={() => undo(entry.recommendationId)}
          />
        );
      },
    }),
  ]);
}

export function ActivityTable({
  clusterId,
  activity,
  loading,
}: {
  clusterId: string | null;
  activity: AuditAction[];
  loading: boolean;
}) {
  const mounted = useMounted();
  const undo = useRollbackRecommendation(clusterId);
  const columns = useMemo(() => buildColumns(mounted, undo.mutate), [mounted, undo.mutate]);

  return (
    <DataTable
      className="mt-2"
      caption="Every executed operation and its outcome"
      columns={columns}
      data={activity}
      loading={loading}
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
