// The dashboard's live half: one SSE subscription per shown cluster, answered
// with invalidations. The worker announces that something landed — a pass, a
// hide, a graduation, a regression — and the matching queries refetch through
// the same reads the page already has. No second copy of any row, no state
// beside the cache to drift from it (#22, and the note in #12): reacting to an
// event IS `invalidateQueries`, so everything about how data renders, fails
// and defaults stays exactly where it is.
import { type ClusterEvent, clusterEvent, clusterTask } from "@repo/contracts";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { api } from "../api";
import { isStatus } from "./errors";
import { queryKeys } from "./keys";

// What each event moves, named key by key — same rule as the mutations
// (mutations/recommendations.ts): the list is checkable against what the
// worker actually writes, instead of trusting a blanket "something changed".
//
//   collect            snapshots and latency samples landed: the collection
//                      footprint and its trend over time, both latency reads,
//                      the node roster, and the cluster list — lastCollectedAt
//                      is how the bar shows freshness
//   classify/suggest   recommendations were deleted/re-inserted or created
//   apply/finalize     rows changed state, the trail and the ROI headline
//                      moved with them
//   probe              writes nothing itself — it queues a suggest, whose own
//                      pass event follows
//   every pass         its own timing (#571), so the passes panel moves on
//                      every one of them, probe included
//
// The three transition events land mid-pass, so the dashboard moves when the
// row does rather than when the loop ends; the pass event closing the same
// keys behind them is a refetch TanStack Query dedupes, not a second round
// trip.
export function invalidationKeys(
  clusterId: string,
  event: ClusterEvent,
): readonly (readonly unknown[])[] {
  switch (event.kind) {
    case "PASS_FINISHED":
      return [...passKeys(clusterId, event.task), queryKeys.passes(clusterId)];
    case "DROP_HIDDEN":
    case "BUILD_GRADUATED":
      return [
        queryKeys.recommendations(clusterId),
        queryKeys.activity(clusterId),
        queryKeys.roi(clusterId),
        // A hide is a state the inventory draws in its own right, not only a
        // recommendation state: `hidden` comes off the index's spec.
        queryKeys.clusterIndexesAll(clusterId),
      ];
    // The one event that always writes a cooldown: both places that fire it call
    // recordRegression first (jobs/finalize.ts). The parked panel is the only
    // screen that shows what a regression cost, so it moves when the row does
    // rather than waiting for the pass to end.
    case "REGRESSION_FIRED":
      return [
        queryKeys.recommendations(clusterId),
        queryKeys.activity(clusterId),
        queryKeys.roi(clusterId),
        queryKeys.cooldowns(clusterId),
        // The rolled-back row leaves the live states, so the inventory's link
        // column has to stop pointing at it.
        queryKeys.clusterIndexesAll(clusterId),
      ];
  }
}

// What one landed pass moved besides its own timing, which every pass moves.
function passKeys(clusterId: string, task: ClusterEvent["task"]): readonly (readonly unknown[])[] {
  switch (task) {
    case "collect":
      return [
        queryKeys.collections(clusterId),
        // Every page of the index inventory, by prefix (#431): a collect
        // moves every index's size and counters, not the page in view.
        queryKeys.clusterIndexesAll(clusterId),
        queryKeys.indexSizeSeries(clusterId),
        queryKeys.latency(clusterId),
        queryKeys.latencySeries(clusterId),
        queryKeys.nodes(clusterId),
        queryKeys.clusters(),
      ];
    case "classify":
    case "suggest":
      // The inventory's last column is "is something proposing to change
      // this index", so a pass that rewrites the proposals moves it too —
      // even though not one measurement on the page has changed.
      return [
        queryKeys.recommendations(clusterId),
        queryKeys.clusterIndexesAll(clusterId),
        // The scanning workload is REWRITTEN by the suggest pass — every
        // shape's outcome is decided there — so this is the event that
        // moves it, not the collect (#432).
        queryKeys.clusterWorkloadAll(clusterId),
      ];
    case "apply":
    case "finalize":
      return [
        queryKeys.recommendations(clusterId),
        queryKeys.activity(clusterId),
        queryKeys.roi(clusterId),
        // finalize is where both regression gates run, and each of them
        // parks an index (#159). apply shares this arm and writes no
        // cooldown of its own — an invalidation that refetches an unchanged
        // list is cheaper than two arms that have to be kept apart.
        queryKeys.cooldowns(clusterId),
        // Same column: a drop that executes takes its row out of the live
        // states, and a build that graduates puts one in.
        queryKeys.clusterIndexesAll(clusterId),
      ];
    default:
      return [];
  }
}

function applyEvent(queryClient: QueryClient, clusterId: string, event: ClusterEvent): void {
  for (const queryKey of invalidationKeys(clusterId, event)) {
    void queryClient.invalidateQueries({ queryKey });
  }
}

// Reconnection is the steady state, not the exception: the api ends every
// stream after five minutes on purpose (its re-auth cadence), so a clean end
// reconnects after the floor delay, and only failures back off. 401/403/404
// end the subscription outright — they mean this reader may not hear this
// cluster, which no amount of retrying changes; signing back in remounts the
// dashboard and the hook with it.
const RETRY_FLOOR_MS = 1_000;
const RETRY_CEILING_MS = 30_000;

function subscriptionOver(error: unknown): boolean {
  return isStatus(error, 401) || isStatus(error, 403) || isStatus(error, 404);
}

async function listen(
  queryClient: QueryClient,
  clusterId: string,
  signal: AbortSignal,
): Promise<void> {
  let delay = RETRY_FLOOR_MS;
  while (!signal.aborted) {
    try {
      const events = await api().listClusterEvents({ clusterId }, { signal });
      for await (const event of events) {
        delay = RETRY_FLOOR_MS;
        applyEvent(queryClient, clusterId, event);
      }
    } catch (error) {
      if (signal.aborted) return;
      if (subscriptionOver(error)) return;
      delay = Math.min(delay * 2, RETRY_CEILING_MS);
    }
    // After a clean end AND after a failure — an api that closes instantly
    // every time must not become a busy-loop of connects.
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

// Every event the stream can carry, read off the contract rather than listed
// here, so a kind or a task added there is covered without anyone having to
// remember this. PASS_FINISHED is the only kind that names a task; the
// transitions carry none.
const EVERY_EVENT: readonly ClusterEvent[] = clusterEvent.shape.kind.options.flatMap(
  (kind): ClusterEvent[] =>
    kind === "PASS_FINISHED"
      ? clusterTask.options.map((task) => ({ kind, task }))
      : [{ kind, task: null }],
);

// What the tab has to refetch when it starts listening again: everything any
// event could have moved, once each. Invalidation matches by prefix, so a key
// that two events share is one refetch however many events name it.
export function resumeKeys(clusterId: string): readonly (readonly unknown[])[] {
  const seen = new Map<string, readonly unknown[]>();
  for (const event of EVERY_EVENT) {
    for (const queryKey of invalidationKeys(clusterId, event)) {
      seen.set(JSON.stringify(queryKey), queryKey);
    }
  }
  return [...seen.values()];
}

// `hidden` and nothing else, because the other value a browser has reported is
// `prerender`, and a page being prerendered is about to be shown.
function tabHidden(): boolean {
  return document.visibilityState === "hidden";
}

// Browser-only by construction (an effect), which is right: SSR renders once
// and leaves; a subscription is for a page that stays.
//
// And only while the tab is SHOWN (#548). An open stream is not free to the
// api's database. The api ends it every five minutes to re-check ownership,
// the reopen queries postgres, and the listener holds a `LISTEN` session
// throughout. A database that suspends after five idle minutes therefore never
// suspends while a tab sits in the background with a cluster open. So a hidden
// tab closes its stream, and showing it reopens the stream and refetches what
// the events would have said. The refetch is needed, not a nicety: the stream
// replays nothing (a missed event is simply gone), and TanStack Query's own
// focus refetch covers only queries both mounted and past their 30 s
// `staleTime`, so a short hide would leave a landed collect unseen.
export function useLiveClusterEvents(clusterId: string | null): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (clusterId === null) return;
    let controller: AbortController | null = null;
    const start = () => {
      controller = new AbortController();
      void listen(queryClient, clusterId, controller.signal);
    };
    const stop = () => {
      controller?.abort();
      controller = null;
    };
    const onVisibility = () => {
      if (tabHidden()) {
        stop();
        return;
      }
      // A visibilitychange that leaves the tab shown — or a second one — must
      // not open a second stream beside the first.
      if (controller !== null) return;
      start();
      for (const queryKey of resumeKeys(clusterId)) {
        void queryClient.invalidateQueries({ queryKey });
      }
    };
    // A tab opened in the background waits to be looked at. What it loaded is
    // current as of its mount, and the refetch on first showing covers the rest.
    if (!tabHidden()) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [clusterId, queryClient]);
}
