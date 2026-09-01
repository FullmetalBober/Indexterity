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
import type { ClusterIndexRow } from "@repo/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { IndexTable } from "~/components/app/index-table";
import { Unavailable } from "~/components/app/unavailable";
import { Button } from "~/components/ui/button";
import { LocalTime } from "~/lib/local-time";
import { useCluster } from "~/lib/queries/shell";
import {
  type ClusterIndexPage,
  clusterIndexesQuery,
  nodesQuery,
  useClusterIndexes,
  useNodes,
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
    </>
  );
}
