import type { ClusterEngine, ClusterIndexRow, ClusterNodes } from "@repo/contracts";
import { indexFlags, keyPattern } from "@repo/contracts";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { fmtBytes } from "~/components/app/format";
import { type UsageSplit, usageDetail, usageLine, usageSplit } from "~/components/app/index-usage";
import { type DashboardColumns, DataTable, dashboardColumns } from "~/components/data-table";
import { Truncated } from "~/components/truncated";
import { Badge } from "~/components/ui/badge";

const column = dashboardColumns<ClusterIndexRow>();

// The per-node split, built once per payload rather than per cell: `usageSplit`
// walks the roster for every row, and a table of a hundred indexes re-walking it
// on each render is the same waste the recommendations table names.
interface SplitEntry {
  readonly usage: UsageSplit;
  readonly detail: string[];
}

// Exactly the recommendations table's usage cell, drawn from exactly the same
// module (#431 asked for this verbatim, and the reason is the rule inside it): a
// per-node number that silently omits an unreachable secondary is WORSE than the
// total it replaced, so a member that did not answer is NAMED in the tooltip and
// never counted as a zero.
function UsageCell({ split }: { split: SplitEntry | undefined }) {
  if (split === undefined) return <span className="text-muted-foreground text-xs">—</span>;
  const { usage, detail } = split;
  const line = usageLine(usage);
  const blind = usage.blindSpots.length;
  return (
    <Truncated
      className={usage.concentrated ? "text-amber-700" : "text-muted-foreground"}
      full={
        <span className="block whitespace-pre-line">
          {usage.concentrated
            ? "Nearly all of this index's operations are on one member — it is likely serving a read-preference client rather than the application.\n\n"
            : ""}
          {detail.join("\n")}
        </span>
      }
    >
      {blind === 0 ? line : `${line} · ${blind} not reported`}
    </Truncated>
  );
}

// Only the flags that are SET, worded for the engine that set them — see
// @repo/contracts/index-flags.ts. Drawing a column of "no"s would be a MongoDB
// vocabulary with two engines' blanks in it, which is the thing #431 asked this
// page not to be.
//
// `hinted` sits with them rather than in a column of its own: it is the same
// kind of fact — a state of this index that decides what the engine may do to
// it — and it is the one the customer could previously only infer from a
// recommendation never appearing.
function FlagsCell({ row, engine }: { row: ClusterIndexRow; engine: ClusterEngine }) {
  const flags = indexFlags(row, engine);
  if (flags.length === 0 && !row.hinted) {
    return <span className="text-muted-foreground text-xs">—</span>;
  }
  return (
    <span className="flex flex-wrap gap-1">
      {flags.map((flag) => (
        <Badge key={flag.label} variant="secondary" title={flag.title}>
          {flag.label}
        </Badge>
      ))}
      {row.hinted ? (
        <Badge
          variant="outline"
          title="A query names this index with hint(). Hiding it would break those queries rather than slow them, so the engine will not observe or re-order it."
        >
          hinted
        </Badge>
      ) : null}
    </span>
  );
}

function buildColumns(
  clusterId: string,
  splits: Map<string, SplitEntry>,
  engine: ClusterEngine,
): DashboardColumns<ClusterIndexRow> {
  return column.columns([
    // One accessor over both halves of the namespace, so sorting groups a
    // collection's indexes together instead of interleaving every database's —
    // which is most of what this page is for: an index is judged next to the
    // others on its collection.
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
    column.accessor("indexName", {
      header: "Index",
      sortFn: "alphanumeric",
      cell: (info) => (
        <span className="block truncate font-mono text-xs" title={info.getValue()}>
          {info.getValue()}
        </span>
      ),
    }),
    // The key pattern is the one cell whose full value a reader genuinely needs
    // and cannot guess from its head — `{ tenant: 1, status: 1, created: -1 }`
    // clips to something that looks like a single-field index — so it gets a
    // measured tooltip rather than a `title`.
    column.accessor((row) => keyPattern(row.keys), {
      id: "keys",
      header: "Keys",
      sortFn: "alphanumeric",
      cell: (info) => {
        const row = info.row.original;
        // The covering columns and the predicate belong with the keys: they are
        // what makes two indexes on the same fields different objects.
        const extra = [
          row.include.length === 0 ? null : `includes ${row.include.join(", ")}`,
          row.partialFilter === null ? null : `where ${JSON.stringify(row.partialFilter)}`,
          row.collation === null ? null : `collation ${row.collation}`,
        ].filter((line) => line !== null);
        return (
          <Truncated
            className="font-mono text-xs"
            full={
              <span className="block whitespace-pre-line font-mono">
                {[info.getValue(), ...extra].join("\n")}
              </span>
            }
          >
            {info.getValue()}
          </Truncated>
        );
      },
    }),
    column.accessor((row) => indexFlags(row, engine).length + (row.hinted ? 1 : 0), {
      id: "flags",
      header: "Flags",
      sortFn: "basic",
      sortDescFirst: true,
      cell: (info) => <FlagsCell row={info.row.original} engine={engine} />,
    }),
    column.accessor("sizeBytes", {
      header: "Size",
      sortFn: "basic",
      // This column is how a reader finds what the footprint is going on, so the
      // first click puts the biggest at the top.
      sortDescFirst: true,
      cell: (info) => fmtBytes(info.getValue()),
    }),
    column.accessor("totalOps", {
      header: "Usage",
      sortFn: "basic",
      // And this one is how they find what nothing is using, so the first click
      // puts the busiest at the top and the second puts the idle there.
      sortDescFirst: true,
      cell: (info) => <UsageCell split={splits.get(info.row.original.id)} />,
    }),
    column.accessor((row) => row.recommendation?.type ?? "", {
      id: "proposed",
      header: "Proposed",
      sortFn: "text",
      cell: (info) => {
        const rec = info.row.original.recommendation;
        if (rec === null) return <span className="text-muted-foreground text-xs">—</span>;
        // To the overview, where the recommendations table is and where the
        // approve/undo buttons live. Not to a per-recommendation route: there is
        // none, and inventing a page so a cell can link somewhere is a page
        // nobody asked for.
        return (
          <Link
            to="/app/clusters/$clusterId"
            params={{ clusterId }}
            className="text-xs underline underline-offset-2"
            title={`${rec.type} in state ${rec.state} — open the proposals table`}
          >
            {rec.type}
          </Link>
        );
      },
    }),
  ]);
}

export function IndexTable({
  clusterId,
  indexes,
  roster,
  engine,
  loading,
}: {
  clusterId: string;
  indexes: ClusterIndexRow[];
  // The node roster from the same collect. It is what turns "3 members
  // reported" into "3 of 5", and null before it has answered — no roster is not
  // evidence of full coverage, so nothing is claimed from one.
  roster: ClusterNodes | null;
  // Which vocabulary the flags are drawn in. Off the cluster the layout already
  // holds, so the badge and this table cannot disagree about the engine.
  engine: ClusterEngine;
  loading: boolean;
}) {
  const splits = useMemo(() => {
    const built = new Map<string, SplitEntry>();
    for (const row of indexes) {
      const split = usageSplit({ totalOps: row.totalOps, perMember: row.perMember }, roster);
      if (split === null) continue;
      built.set(row.id, { usage: split, detail: usageDetail(split, row.observedAt) });
    }
    return built;
  }, [indexes, roster]);

  const columns = useMemo(
    () => buildColumns(clusterId, splits, engine),
    [clusterId, splits, engine],
  );

  return (
    <DataTable
      className="mt-2"
      caption="Every index this cluster has, with its size and per-member usage"
      columns={columns}
      data={indexes}
      loading={loading}
      getRowId={(row) => row.id}
      // Namespace order, which is the order the api paged in: sorting a page by
      // size and calling it "the biggest indexes" would be a claim about the
      // cluster made from a hundred of its rows.
      initialSorting={[{ id: "namespace", desc: false }]}
      filterLabel="Filter indexes"
      // A page is at most CLUSTER_INDEXES_PAGE rows and each is single-line, so
      // they estimate the same as a collection's.
      virtualize={{ maxHeight: 560, estimateRowHeight: 44 }}
      // Collection, Index, Keys, Flags, Size, Usage, Proposed.
      columnWidths={[220, 200, 240, 160, 100, 200, 160]}
      // The keys column absorbs the slack: it is the one holding something of
      // genuinely unpredictable length, and the numbers beside it gain nothing
      // from being wider than their headers.
      flexColumn={{ index: 2 }}
      empty={{
        title: "Nothing collected yet",
        description:
          "The inventory appears after the first collect, which runs from the moment a cluster is connected.",
      }}
    />
  );
}
