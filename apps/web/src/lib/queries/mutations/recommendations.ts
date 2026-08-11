// Approve, undo, un-hide. Each of them moves the row itself, the audit trail
// that records what was done to it, and the ROI headline, which changes as soon
// as a drop completes or is undone. Nothing else — approving a recommendation
// does not touch the latency series or the collection footprint.
//
// Two of the three move a fourth: un-hiding and undoing both call
// `recordManualVeto`, so the index is parked for 90 days and the parked panel
// (#159) is stale the moment either succeeds. Approving parks nothing.
import type { Recommendation } from "@repo/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../../api";
import { queryKeys } from "../keys";

const APPROVE_FAILED = "Approve failed — are you an owner, and is the API up?";
const UNHIDE_FAILED = "Could not un-hide — the cluster may be unreachable or read-only";
const UNDO_FAILED = "Undo failed — the cluster may be unreachable or read-only";

// The cluster has to be in the key, so each of these is bound to the cluster the
// dashboard resolved rather than reaching for a selection of its own.
function usePipelineMutation(
  clusterId: string | null,
  run: (recommendationId: string) => Promise<Recommendation>,
  // `parks` is not cosmetic: it is the fourth key this write moves, named the
  // same way the other three are, so the list stays checkable against the api.
  messages: { ok: string; failed: string; parks: boolean },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => toast.success(messages.ok),
    onError: () => toast.error(messages.failed),
    // Refetched either way: a failure here can mean the api rejected it, and
    // the row's real state is whatever the api now says it is. This was an
    // invalidate inside onSuccess while a server function sat in the middle
    // turning a refusal into { ok: false } — a rejection that arrived as a
    // success. The api's refusal now arrives as one, so the "either way" is
    // onSettled rather than a branch.
    //
    // Three invalidations rather than one blanket key. Naming them is the point:
    // it is a list of what this write actually moves, and the reader of this file
    // can check it against the api instead of trusting a grouping.
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.recommendations(clusterId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.roi(clusterId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.activity(clusterId) }),
        ...(messages.parks
          ? [queryClient.invalidateQueries({ queryKey: queryKeys.cooldowns(clusterId) })]
          : []),
      ]);
    },
  });
}

export function useApproveRecommendation(clusterId: string | null) {
  return usePipelineMutation(clusterId, (id) => api().approveRecommendation({ id }), {
    ok: "Approved — enters the pipeline on the next tick",
    failed: APPROVE_FAILED,
    parks: false,
  });
}

export function useUnhideRecommendation(clusterId: string | null) {
  return usePipelineMutation(clusterId, (id) => api().unhideRecommendation({ id }), {
    ok: "Index un-hidden — this drop won't be proposed again for 90 days",
    failed: UNHIDE_FAILED,
    parks: true,
  });
}

export function useRollbackRecommendation(clusterId: string | null) {
  return usePipelineMutation(clusterId, (id) => api().rollbackRecommendation({ id }), {
    ok: "Undo complete — the index was rebuilt",
    failed: UNDO_FAILED,
    parks: true,
  });
}
