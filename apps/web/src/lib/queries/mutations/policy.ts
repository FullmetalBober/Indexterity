// Saving the engine knobs for one cluster.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { savePolicy } from "../../app-server";
import { queryKeys } from "../keys";

interface PolicyDraft {
  readonly clusterId: string;
  readonly workloadAnalysis: boolean;
  readonly instantCreate: boolean;
  readonly observeWindowDays: number;
  readonly autoApplyScore: number | null;
  readonly changeWindowStartHour: number | null;
  readonly changeWindowEndHour: number | null;
}

export function useSavePolicy() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (draft: PolicyDraft) => savePolicy({ data: draft }),
    onSuccess: (result, draft) => {
      if (!result.ok) {
        // The api's own reason — a plan limit reads nothing like a role problem.
        toast.error(result.message ?? "policy not saved");
        return;
      }
      toast.success("Policy saved");
      // The draft's clusterId is the cluster the dashboard resolved, so this is
      // the same key the form was filled from.
      return queryClient.invalidateQueries({ queryKey: queryKeys.policy(draft.clusterId) });
    },
    onError: () => toast.error("policy not saved"),
  });
}
