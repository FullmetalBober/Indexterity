// The dashboard's live half: one SSE subscription per shown cluster, answered
// with invalidations. The worker announces that something landed — a pass, a
// hide, a graduation, a regression — and the matching queries refetch through
// the same reads the page already has. No second copy of any row, no state
// beside the cache to drift from it (#22, and the note in #12): reacting to an
// event IS `invalidateQueries`, so everything about how data renders, fails
// and defaults stays exactly where it is.
import type { ClusterEvent } from "@repo/contracts";
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
//                      footprint, both latency reads, and the cluster list —
//                      lastCollectedAt is how the bar shows freshness
//   classify/suggest   recommendations were deleted/re-inserted or created
//   apply/finalize     rows changed state, the trail and the ROI headline
//                      moved with them
//   probe              writes nothing itself — it queues a suggest, whose own
//                      pass event follows
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
      switch (event.task) {
        case "collect":
          return [
            queryKeys.collections(clusterId),
            queryKeys.latency(clusterId),
            queryKeys.latencySeries(clusterId),
            queryKeys.nodes(clusterId),
            queryKeys.clusters(),
          ];
        case "classify":
        case "suggest":
          return [queryKeys.recommendations(clusterId)];
        case "apply":
        case "finalize":
          return [
            queryKeys.recommendations(clusterId),
            queryKeys.activity(clusterId),
            queryKeys.roi(clusterId),
          ];
        default:
          return [];
      }
    case "DROP_HIDDEN":
    case "BUILD_GRADUATED":
    case "REGRESSION_FIRED":
      return [
        queryKeys.recommendations(clusterId),
        queryKeys.activity(clusterId),
        queryKeys.roi(clusterId),
      ];
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

// Browser-only by construction (an effect), which is right: SSR renders once
// and leaves; a subscription is for a page that stays.
export function useLiveClusterEvents(clusterId: string | null): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (clusterId === null) return;
    const controller = new AbortController();
    void listen(queryClient, clusterId, controller.signal);
    return () => controller.abort();
  }, [clusterId, queryClient]);
}
