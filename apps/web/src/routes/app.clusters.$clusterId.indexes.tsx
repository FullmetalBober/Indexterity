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
// One route, two tables, and deliberately not one component: they share a
// subject and nothing else — different reads, different cursors, and either can
// fail without blanking the other (#289).
import type { ClusterIndexRow } from "@repo/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { IndexTable } from "~/components/app/index-table";
import { Unavailable } from "~/components/app/unavailable";
import { WorkloadTable } from "~/components/app/workload-table";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { Label } from "~/components/ui/label";
import { LocalTime } from "~/lib/local-time";
import { useCluster } from "~/lib/queries/shell";
import {
  type ClusterIndexPage,
  clusterIndexesQuery,
  clusterWorkloadQuery,
  nodesQuery,
  useClusterIndexes,
  useClusterWorkload,
  useNodes,
  type WorkloadPage,
} from "~/lib/queries/telemetry";

export const Route = createFileRoute("/app/clusters/$clusterId/indexes")({
  // Two reads, warmed and not awaited in the browser — the same rule as the two
  // tabs beside it (D117). The roster is the second because the usage column is
  // only honest with it: "3 of 5 nodes" needs to know there are five, and a
  // member the collect never reached must be NAMED rather than counted as a
  // zero.
  //
  // Only the FIRST page is warmed. A cursor is state the reader creates by
  // clicking, so warming anything but the first would be prefetching a page
  // nobody has asked for.
  loader: async ({ params, context }) => {
    const id = params.clusterId;
    const warm = Promise.allSettled([
      context.queryClient.ensureQueryData(clusterIndexesQuery(id)),
      context.queryClient.ensureQueryData(nodesQuery(id)),
      context.queryClient.ensureQueryData(clusterWorkloadQuery(id)),
    ]);
    if (import.meta.env.SSR) await warm;
  },
  head: () => ({ meta: [{ title: "Indexes — Indexterity" }] }),
  component: ClusterIndexesPage,
});

// Where the reader is in the keyset, as a stack rather than a page number.
//
// A keyset cursor can only step forward, so "back" is the cursor that produced
// the previous page — which nothing but the reader's own history knows. Keeping
// the stack makes Back exact instead of approximate, and it costs one array.
type Cursor = Required<
  Pick<ClusterIndexPage, "afterDatabase" | "afterCollection" | "afterIndexName">
>;

// The workload half's cursor, same shape and same reason: keyset pages only
// step forward, so Back is the cursor that produced the previous page and
// nothing but the reader's own history knows it.
type CostCursor = Required<Pick<WorkloadPage, "afterWeeklyDocsExamined" | "afterId">>;

function costCursorFrom(payload: {
  nextWeeklyDocsExamined: number | null;
  nextId: string | null;
}): CostCursor | null {
  if (payload.nextWeeklyDocsExamined === null || payload.nextId === null) return null;
  return {
    afterWeeklyDocsExamined: payload.nextWeeklyDocsExamined,
    afterId: payload.nextId,
  };
}

function cursorFrom(payload: {
  nextDatabase: string | null;
  nextCollection: string | null;
  nextIndexName: string | null;
}): Cursor | null {
  // All three or none: the api sends them together and a partial cursor would
  // page from a boundary it never named.
  if (
    payload.nextDatabase === null ||
    payload.nextCollection === null ||
    payload.nextIndexName === null
  ) {
    return null;
  }
  return {
    afterDatabase: payload.nextDatabase,
    afterCollection: payload.nextCollection,
    afterIndexName: payload.nextIndexName,
  };
}

function ClusterIndexesPage() {
  const { clusterId: id } = Route.useParams();
  // Off the live cluster list rather than a read of its own — the layout above
  // already draws this cluster's badge from it, and the flag wording and the
  // badge must not be able to disagree about the engine.
  const cluster = useCluster(id);
  const [stack, setStack] = useState<Cursor[]>([]);
  const page = stack[stack.length - 1];
  const inventory = useClusterIndexes(id, page ?? {});
  const nodes = useNodes(id);

  // The workload half's own state. Its own cursor stack, because the two tables
  // page independently, and its own filter — "only the ones you declined" is the
  // question this page exists to answer and the one no other screen can.
  const [costStack, setCostStack] = useState<CostCursor[]>([]);
  const [declinedOnly, setDeclinedOnly] = useState(false);
  const costPage = costStack[costStack.length - 1];
  const workload = useClusterWorkload(id, {
    ...(costPage ?? {}),
    ...(declinedOnly ? { declinedOnly: true } : {}),
  });
  const nextCost = costCursorFrom(workload.data);

  const rows: ClusterIndexRow[] = inventory.data.indexes;
  const next = cursorFrom(inventory.data);
  const shown = rows.length;

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
          {inventory.data.total > 0 ? (
            <>
              {" · "}
              {shown === inventory.data.total
                ? `${inventory.data.total} indexes`
                : `${shown} of ${inventory.data.total} indexes`}
            </>
          ) : null}
        </p>
      )}

      {inventory.failed ? (
        <Unavailable what="the index inventory" onRetry={inventory.retry} />
      ) : (
        <IndexTable
          clusterId={id}
          indexes={rows}
          roster={nodes.data}
          // MongoDB until the cluster list has answered. The wording it decides
          // is the wording of flags that are SET, and an index that is hidden or
          // sparse under any engine is still hidden or sparse — the only thing a
          // wrong guess for one render changes is whether a shard key is called
          // a primary key, which the next render corrects.
          engine={cluster?.engine ?? "MONGODB"}
          loading={inventory.pending}
        />
      )}

      {/* Offered only when the api said there IS a next page. Paging into an
          empty one to discover the end is how a reader concludes the inventory
          stops where it does not — the same rule the security trail follows. */}
      {stack.length === 0 && next === null ? null : (
        <div className="mt-4 flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={stack.length === 0}
            onClick={() => setStack((current) => current.slice(0, -1))}
          >
            Back
          </Button>
          {next === null ? (
            <span className="text-muted-foreground text-xs">The end of the inventory.</span>
          ) : (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setStack((current) => [...current, next])}
            >
              More
            </Button>
          )}
        </div>
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
              // A filter change invalidates the cursor: it was a position in a
              // different result set, and paging from it would land somewhere
              // the api never named.
              setCostStack([]);
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
            <WorkloadTable shapes={workload.data.shapes} loading={workload.pending} />
          )}
        </div>

        {costStack.length === 0 && nextCost === null ? null : (
          <div className="mt-4 flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={costStack.length === 0}
              onClick={() => setCostStack((current) => current.slice(0, -1))}
            >
              Back
            </Button>
            {nextCost === null ? (
              <span className="text-muted-foreground text-xs">The end of the list.</span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setCostStack((current) => [...current, nextCost])}
              >
                More
              </Button>
            )}
          </div>
        )}
      </section>
    </>
  );
}
