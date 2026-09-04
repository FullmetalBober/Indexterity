// Every index this cluster has — the page #431 asked for.
//
// The gap it closes is not a missing measurement. `cluster_indexes` has carried
// each index's spec since #67 and `index_snapshots` its size and per-member
// counters, and index-level numbers reached the dashboard only through
// `IndexUsage`, which is keyed by `recommendationId` (D66). So an index nobody
// had proposed anything about had no row on any screen: the only indexes a
// customer could see were the ones we already wanted to change, and everything
// the engine judged fine was invisible along with the judgement.
//
// Three things follow from that, and they are what this page is arranged around:
// approving a drop is a decision about a SET made with one element of it in
// view; an inventory is the answer to "what did you actually look at"; and
// `hidden`, `hinted` and each member's counter start were collected and never
// once displayed.
//
// The second table is the same argument about the OTHER side of the engine
// (#432). `collectWorkload` returns every scanning query shape with its cost;
// `jobs/suggest.ts` read them once an hour and persisted only the
// recommendations that cleared every gate, so a query walking 900k documents a
// week on a small collection was seen, priced, discarded and never mentioned.
// Both halves of this page exist because a finding was being deleted along with
// the proposal it did not become.
//
// One page, two tables, and deliberately not one component: they share a
// subject and nothing else — different reads, different paging, and either can
// fail without blanking the other (#289).
//
// Both page by OFFSET with page numbers since #445 (D133), and independently:
// two cursors became two page states, because a reader looking at page four of
// the inventory has said nothing about where they are in the workload list.
//
// The SORT and the FILTER are the api's too (D135). Which is the point rather
// than a detail: the server chooses which rows the page holds, so a control that
// ordered the hundred rows already in the browser would be sorting an arbitrary
// hundred and calling it the cluster. All three live here because all three are
// what the next request is made from.
//
// A component with the cluster as a prop, and not the route's own body (#455),
// so it can be rendered against a fake api. A click on page two has to become a
// request for offset 100, and that seam — the view's state, the query's key, the
// api's input — is one no unit of it can prove alone: the table test mocks the
// callback, the api test calls `?offset=` directly, and for three releases every
// page of this table hashed to one cache entry while all of them stayed green.
// The route (routes/app.clusters.$clusterId.indexes.tsx) is the loader and a
// wrapper that reads the param.
import {
  CLUSTER_INDEXES_PAGE,
  CLUSTER_INDEXES_PAGE_SIZES,
  type ClusterIndexRow,
  type IndexSortKey,
  indexSortKey,
  WORKLOAD_SHAPES_PAGE,
  WORKLOAD_SHAPES_PAGE_SIZES,
  type WorkloadSortKey,
  workloadSortKey,
} from "@repo/contracts";
import { useState } from "react";
import { IndexTable } from "~/components/app/index-table";
import { Unavailable } from "~/components/app/unavailable";
import { WorkloadTable } from "~/components/app/workload-table";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { LocalTime } from "~/lib/local-time";
import { type PagedViewInitial, usePagedView } from "~/lib/paged-view";
import { useCluster } from "~/lib/queries/shell";
import { useClusterIndexes, useClusterWorkload, useNodes } from "~/lib/queries/telemetry";

// Where each table starts: the first page, in the order the api pages in, over
// the keys the api can order by. Module level and exported because the route's
// loader warms the entry this component reads, and the two must be built from
// the same request (#455): the request is the cache key, so a loader warming
// `{}` while the component asked for the first page in full would fill an entry
// nobody reads and the tab would draw a skeleton on every SSR.
export const INVENTORY_VIEW: PagedViewInitial<IndexSortKey> = {
  pageSize: CLUSTER_INDEXES_PAGE,
  // Namespace order, which is the order the api pages in: an index is judged
  // next to the others on its collection.
  sort: { id: "namespace", desc: false },
  sortKeys: indexSortKey.options,
};

// Worst first, by documents walked per week: this list is ranked, not browsed.
export const WORKLOAD_VIEW: PagedViewInitial<WorkloadSortKey> = {
  pageSize: WORKLOAD_SHAPES_PAGE,
  sort: { id: "weeklyDocsExamined", desc: true },
  sortKeys: workloadSortKey.options,
};

export function ClusterIndexesPage({ clusterId }: { clusterId: string }) {
  // Off the live cluster list rather than a read of its own — the layout above
  // already draws this cluster's badge from it, and the flag wording and the
  // badge must not be able to disagree about the engine.
  const cluster = useCluster(clusterId);
  // The reader's position, as a page rather than a cursor stack. Owned here and
  // not by the table, because it is what the next request is made from — the
  // table does the arithmetic over it and nothing else.
  const inventoryView = usePagedView(INVENTORY_VIEW);
  const inventory = useClusterIndexes(clusterId, inventoryView.request);
  const nodes = useNodes(clusterId);

  // The api CLAMPS past the end of a set that shrank, and says where it landed.
  // Following that rather than insisting on the page asked for is what stops the
  // control reading "page 12 of 3" against rows that are plainly the last page.
  //
  // Except while the answer is OUT: `data` is then the page before the one asked
  // for, kept on screen on purpose (PagedRead), and its offset is the previous
  // request's. Drawing that would be the reported bug for the length of the
  // request — a click on 2 with 1 still lit — so the control draws the requested
  // page until the served one arrives.
  const served = inventory.data;

  // The workload half's own page state, because the two tables page
  // independently, and its own filter — "only the ones you declined" is the
  // question this page exists to answer and the one no other screen can.
  const workloadView = usePagedView(WORKLOAD_VIEW);
  const [declinedOnly, setDeclinedOnly] = useState(false);
  const workload = useClusterWorkload(clusterId, {
    ...workloadView.request,
    ...(declinedOnly ? { declinedOnly: true } : {}),
  });
  const costServed = workload.data;

  const rows: ClusterIndexRow[] = inventory.data.indexes;

  return (
    <>
      <h2 className="font-semibold text-lg">Indexes</h2>
      <p className="text-muted-foreground text-sm">
        Every index the last collect saw, whether or not the engine has an opinion about it — its
        keys, what it costs, and which members are using it. Usage is summed across the members that
        answered; one that did not is named in the tooltip, never drawn as a zero.
      </p>
      {inventory.data.collectedAt === null ? null : (
        <p className="mt-1 text-muted-foreground text-xs">
          As of <LocalTime iso={inventory.data.collectedAt} />
          {/* The COUNT only. Which of them this page holds is the footer's line
              now, and two places saying "100 of 517" in different words was one
              of them being a worse copy of the other. */}
          {inventory.data.total > 0 ? `  ·  ${inventory.data.total} indexes` : null}
        </p>
      )}

      {inventory.failed ? (
        <Unavailable what="the index inventory" onRetry={inventory.retry} />
      ) : (
        <IndexTable
          clusterId={clusterId}
          indexes={rows}
          roster={nodes.data}
          // MongoDB until the cluster list has answered. The wording it decides
          // is the wording of flags that are SET, and an index that is hidden or
          // sparse under any engine is still hidden or sparse — the only thing a
          // wrong guess for one render changes is whether a shard key is called
          // a primary key, which the next render corrects.
          engine={cluster?.engine ?? "MONGODB"}
          loading={inventory.pending}
          busy={inventory.placeholder}
          pagination={{
            // The SERVED page, not the requested one: past the end of a set that
            // shrank the api clamps, and the control follows the rows.
            pageIndex: inventory.placeholder
              ? inventoryView.pageIndex
              : inventoryView.servedIndex(served.offset, served.limit),
            pageSize: inventory.placeholder ? inventoryView.pageSize : served.limit,
            rowCount: served.total,
            pageSizes: CLUSTER_INDEXES_PAGE_SIZES,
            noun: "indexes",
            onChange: inventoryView.onPagination,
          }}
          sorting={{ state: inventoryView.sorting, onChange: inventoryView.onSorting }}
          filter={{ value: inventoryView.filter, onChange: inventoryView.onFilter }}
        />
      )}

      <section className="mt-10">
        <h2 className="font-semibold text-lg">Queries missing an index</h2>
        <p className="text-muted-foreground text-sm">
          Every scanning query shape the workload source reported, what it costs, and whether the
          engine proposed an index for it — including the ones it declined, and which gate declined
          them. Worst first, by documents walked per week.
        </p>
        {/* The one gate that leaves nothing behind: create-side analysis returns
            before it reads anything, so an empty table would mean "nothing is
            scanning" when it means "nobody looked". Said here rather than drawn
            as an empty state, which is the #72/#289 rule again. */}
        {workload.data.workloadAnalysisEnabled ? null : (
          <p className="mt-2 text-sm">
            Create-side analysis is switched off for this cluster, so no query shapes are read at
            all. Turn it back on under Settings to see what is scanning.
          </p>
        )}
        <p className="mt-1 text-muted-foreground text-xs">
          {workload.data.analysedAt === null ? null : (
            <>
              As of <LocalTime iso={workload.data.analysedAt} />
              {workload.data.total > 0
                ? ` · ${
                    workload.data.shapes.length === workload.data.total
                      ? `${workload.data.total} shapes`
                      : `${workload.data.shapes.length} of ${workload.data.total} shapes`
                  }`
                : null}
            </>
          )}
          {/* The two gates that fire BEFORE anything is read, so they can have
              no rows of their own — a collection nobody analysed is a fact about
              the collection, not about a query. Reported as counts rather than
              silently left out, which is what "five of the six gates leave no
              trace" was about. */}
          {workload.data.collectionsBelowDocFloor > 0 ||
          workload.data.collectionsAboveSizeCeiling > 0 ? (
            <>
              {workload.data.analysedAt === null ? null : " · "}
              {workload.data.collectionsBelowDocFloor > 0
                ? `${workload.data.collectionsBelowDocFloor} collection${
                    workload.data.collectionsBelowDocFloor === 1 ? "" : "s"
                  } under the 100-document floor`
                : null}
              {workload.data.collectionsBelowDocFloor > 0 &&
              workload.data.collectionsAboveSizeCeiling > 0
                ? ", "
                : null}
              {workload.data.collectionsAboveSizeCeiling > 0
                ? `${workload.data.collectionsAboveSizeCeiling} above the size ceiling`
                : null}
              {" — not analysed"}
            </>
          ) : null}
        </p>

        <div className="mt-3 flex items-center gap-2">
          <Checkbox
            id="declined-only"
            checked={declinedOnly}
            onCheckedChange={(checked) => {
              setDeclinedOnly(checked === true);
              // Back to the first page, the same rule the sort and the search box
              // follow: page four of the unfiltered list is not page four of the
              // filtered one, and the api would clamp anyway.
              workloadView.onPagination({ pageIndex: 0, pageSize: workloadView.pageSize });
            }}
          />
          <Label htmlFor="declined-only" className="text-sm">
            Only the ones nothing was proposed for
          </Label>
        </div>

        <div className="mt-2">
          {workload.failed ? (
            <Unavailable what="the scanning workload" onRetry={workload.retry} />
          ) : (
            <WorkloadTable
              shapes={workload.data.shapes}
              loading={workload.pending}
              busy={workload.placeholder}
              pagination={{
                pageIndex: workload.placeholder
                  ? workloadView.pageIndex
                  : workloadView.servedIndex(costServed.offset, costServed.limit),
                pageSize: workload.placeholder ? workloadView.pageSize : costServed.limit,
                rowCount: costServed.total,
                pageSizes: WORKLOAD_SHAPES_PAGE_SIZES,
                noun: "query shapes",
                onChange: workloadView.onPagination,
              }}
              sorting={{ state: workloadView.sorting, onChange: workloadView.onSorting }}
              filter={{ value: workloadView.filter, onChange: workloadView.onFilter }}
            />
          )}
        </div>
      </section>
    </>
  );
}
