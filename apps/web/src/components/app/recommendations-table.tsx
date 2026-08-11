import type { Recommendation } from "@repo/contracts";
import { useMemo } from "react";
import { badgeVariant, dropsOn } from "~/components/app/format";
import { ConfirmButton } from "~/components/confirm-button";
import { type DashboardColumns, DataTable, dashboardColumns } from "~/components/data-table";
import { Truncated } from "~/components/truncated";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  useApproveRecommendation,
  useRollbackRecommendation,
  useUnhideRecommendation,
} from "~/lib/queries/mutations/recommendations";

const column = dashboardColumns<Recommendation>();

// Taken by id rather than as mutation objects: react-query's `mutate` keeps the
// same reference across renders, so the column list built from these stays stable
// and the row models are not rebuilt on every keystroke in the filter box.
interface Actions {
  readonly approve: (id: string) => void;
  readonly unhide: (id: string) => void;
  readonly undo: (id: string) => void;
}

// What each state offers to do about it, which is the column a reader came for.
// Advisories are the exception: the engine will not touch them at any setting, so
// the cell says so rather than offering a button that would not be honoured.
function action(rec: Recommendation, actions: Actions) {
  if (rec.type === "ADVISORY_REVIEW") {
    return <span className="text-muted-foreground text-xs">review manually</span>;
  }
  if (rec.state === "PROPOSED") {
    return (
      <ConfirmButton
        trigger={
          <Button size="sm" variant="secondary">
            Approve
          </Button>
        }
        title={`Approve ${rec.indexName}?`}
        description={
          <>
            <p>
              {rec.type === "REORDER"
                ? // The one approval that touches a constraint-bearing index, so
                  // it says what is preserved and in what order — a reader
                  // deciding this is owed more than "the index is built".
                  "The replacement is built FIRST, with the same keys and the same options — including the unique constraint, which both indexes then enforce. Only once it has survived its post-build watch is retiring the original proposed, through the usual hide, observe and regression gates. There is no moment when the constraint is not being enforced."
                : rec.type.startsWith("DROP") || rec.type === "MERGE"
                  ? "The index is hidden first and observed before anything is dropped — hiding is instant and reversible."
                  : "The index is built and then watched: if writes regress, the build rolls back automatically."}
            </p>
            <p className="font-mono text-xs">
              {rec.database}.{rec.collection} · {rec.indexName}
            </p>
          </>
        }
        confirmLabel="Approve"
        onConfirm={() => actions.approve(rec.id)}
      />
    );
  }
  if (rec.state === "DROPPED") {
    return (
      <ConfirmButton
        trigger={
          <Button size="sm" variant="outline">
            Undo
          </Button>
        }
        title={`Rebuild ${rec.indexName}?`}
        description="The index is recreated from the spec recorded at drop time, and the ROI headline is corrected back down."
        confirmLabel="Rebuild"
        onConfirm={() => actions.undo(rec.id)}
      />
    );
  }
  if (rec.state === "HIDDEN") {
    return (
      <ConfirmButton
        trigger={
          <Button size="sm" variant="outline">
            Keep it
          </Button>
        }
        title={`Cancel the pending drop of ${rec.indexName}?`}
        description="The index becomes visible to the query planner again straight away, and this drop is not proposed again for 90 days."
        confirmLabel="Un-hide"
        onConfirm={() => actions.unhide(rec.id)}
      />
    );
  }
  return <span className="text-muted-foreground text-xs">{rec.state}</span>;
}

function buildColumns(actions: Actions): DashboardColumns<Recommendation> {
  // column.columns() rather than a bare array: it threads each column's own
  // value type out through a variadic tuple, so a string column and a number
  // column can sit in one list without both widening to unknown.
  return column.columns([
    column.accessor("type", {
      header: "Type",
      sortFn: "text",
      cell: (info) => <Badge variant={badgeVariant(info.getValue())}>{info.getValue()}</Badge>,
    }),
    // One accessor over both halves of the namespace, so sorting groups a
    // collection's indexes together instead of interleaving every database's.
    column.accessor((rec) => `${rec.database}.${rec.collection}`, {
      id: "namespace",
      header: "Collection",
      sortFn: "alphanumeric",
      // See collections-table: a fixed column will not grow for a long namespace, so
      // it truncates and keeps the whole value in the title.
      cell: (info) => (
        <span className="block truncate font-mono text-xs" title={info.getValue()}>
          {info.getValue()}
        </span>
      ),
    }),
    column.accessor("indexName", {
      header: "Index",
      sortFn: "alphanumeric",
      cell: (info) => (
        <span className="block truncate font-mono text-xs" title={info.getValue()}>
          {info.getValue()}
        </span>
      ),
    }),
    column.accessor("score", {
      header: "Score",
      sortFn: "basic",
      // Descending first: the reason to sort by confidence is to see the
      // strongest proposals, and a list of the weakest is nobody's first question.
      sortDescFirst: true,
      cell: (info) => {
        const due = dropsOn(info.row.original);
        return (
          <span className="text-xs tabular-nums">
            {info.getValue()}
            {/* Once a drop is hidden the score is history — it decided whether to
                start, and the only open question is when this ends. The window is
                per-index, so it is not something a reader can work out from the
                policy setting. */}
            {due === null ? null : <span className="block text-muted-foreground">drops {due}</span>}
          </span>
        );
      },
    }),
    column.accessor((rec) => rec.usageClass ?? "—", {
      id: "usageClass",
      header: "Usage",
      sortFn: "text",
      cell: (info) => info.getValue(),
    }),
    column.accessor("rationale", {
      header: "Rationale",
      // Prose. Sorting it alphabetically orders nothing a reader is looking for.
      enableSorting: false,
      // The cell that outgrows its column. `columnWidths` clips every cell and the
      // primitive sets `whitespace-nowrap`, so a long rationale used to be cut off
      // mid-sentence with no ellipsis to say so and no way to read the rest — the
      // one column here where the text IS the answer.
      cell: (info) => <Truncated className="text-muted-foreground">{info.getValue()}</Truncated>,
    }),
    column.display({
      id: "action",
      header: "Action",
      cell: (info) => action(info.row.original, actions),
    }),
  ]);
}

export function RecommendationsTable({
  clusterId,
  recommendations,
  total,
  loading,
}: {
  clusterId: string | null;
  recommendations: Recommendation[];
  // How many exist server-side; the api sends the RECOMMENDATIONS_CAP
  // highest-scoring of them (#64). Sorting and filtering below work over what
  // arrived — D33's client-side behaviour, deliberately kept — so when the
  // two numbers differ the table has to say so, or "no rows match" quietly
  // becomes a claim about rows that were never sent.
  total: number;
  loading: boolean;
}) {
  const approve = useApproveRecommendation(clusterId);
  const unhide = useUnhideRecommendation(clusterId);
  const undo = useRollbackRecommendation(clusterId);

  const columns = useMemo(
    () => buildColumns({ approve: approve.mutate, unhide: unhide.mutate, undo: undo.mutate }),
    [approve.mutate, unhide.mutate, undo.mutate],
  );

  const truncated = total > recommendations.length;

  return (
    <>
      {truncated ? (
        <p className="mt-6 text-muted-foreground text-sm">
          Showing the {recommendations.length} highest-scoring of {total.toLocaleString()}{" "}
          recommendations. The filter searches these; the rest surface as they are resolved.
        </p>
      ) : null}
      <DataTable
        className="mt-6"
        caption="Index recommendations for this cluster"
        columns={columns}
        data={recommendations}
        loading={loading}
        getRowId={(rec) => rec.id}
        // Highest confidence first — the ordering a reader would apply by hand.
        initialSorting={[{ id: "score", desc: true }]}
        filterLabel="Filter recommendations"
        // Unbounded by nature: one row per index worth touching, across every
        // collection. Sixty-odd is a normal cluster and thousands is a big one.
        virtualize={{ maxHeight: 640, estimateRowHeight: 64 }}
        // Type, Collection, Index, Score, Usage, Rationale, Action. Rationale takes
        // the most because it is prose and wraps; the two names after it are the other
        // unpredictable ones. Fixing these is what stops the table re-laying itself out
        // as virtualized rows swap — see DataTable's columnWidths.
        columnWidths={[132, 200, 200, 104, 120, 280, 132]}
        // The rationale takes the slack, and takes all of it: the table fills the
        // page now, and the alternative to a long line is a clipped one. Past the
        // column's width the cell truncates and the tooltip carries the rest, so
        // the length of the line is no longer what decides whether it is readable.
        flexColumn={{ index: 5 }}
        empty={{
          title: "No recommendations yet",
          description:
            "The engine proposes changes once it has a week of index usage to reason about. Nothing to review means nothing is obviously wrong.",
        }}
      />
    </>
  );
}
