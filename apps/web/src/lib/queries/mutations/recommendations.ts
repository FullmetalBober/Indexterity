// Approve, undo, un-hide. All three move the same key and nothing else, which is
// the whole reason the dashboard's reads were split into three: approving one
// recommendation used to refetch the latency series and the collection
// footprint too.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  approveRecommendation,
  rollbackRecommendation,
  unhideRecommendation,
} from "../../app-server";
import { queryKeys } from "../keys";

const APPROVE_FAILED = "Approve failed — are you an owner, and is the API up?";
const UNHIDE_FAILED = "Could not un-hide — the cluster may be unreachable or read-only";
const UNDO_FAILED = "Undo failed — the cluster may be unreachable or read-only";

// The cluster has to be in the key, so each of these is bound to the cluster the
// dashboard resolved rather than reaching for a selection of its own.
function usePipelineMutation(
  clusterId: string | null,
  run: (recommendationId: string) => Promise<{ ok: boolean }>,
  messages: { ok: string; failed: string },
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (result) => {
      if (result.ok) toast.success(messages.ok);
      else toast.error(messages.failed);
      // Refetched either way: a failure here can mean the api rejected it, and
      // the row's real state is whatever the api now says it is.
      return queryClient.invalidateQueries({ queryKey: queryKeys.pipeline(clusterId) });
    },
    onError: () => toast.error(messages.failed),
  });
}

export function useApproveRecommendation(clusterId: string | null) {
  return usePipelineMutation(clusterId, (id) => approveRecommendation({ data: id }), {
    ok: "Approved — enters the pipeline on the next tick",
    failed: APPROVE_FAILED,
  });
}

export function useUnhideRecommendation(clusterId: string | null) {
  return usePipelineMutation(clusterId, (id) => unhideRecommendation({ data: id }), {
    ok: "Index un-hidden — this drop won't be proposed again for 90 days",
    failed: UNHIDE_FAILED,
  });
}

export function useRollbackRecommendation(clusterId: string | null) {
  return usePipelineMutation(clusterId, (id) => rollbackRecommendation({ data: id }), {
    ok: "Undo complete — the index was rebuilt",
    failed: UNDO_FAILED,
  });
}
