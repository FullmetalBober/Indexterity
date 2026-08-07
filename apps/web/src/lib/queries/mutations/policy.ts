// Saving the engine knobs for one cluster.
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api } from "../../api";
import { apiMessage } from "../errors";
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
    // The form does not offer a collection-size ceiling, and updatePolicy
    // REPLACES the knobs — so it has to be sent, and sent as "no ceiling",
    // rather than left out and silently defaulted to something else.
    mutationFn: (draft: PolicyDraft) =>
      api().updatePolicy({ ...draft, maxCollectionSizeBytes: null }),
    onSuccess: (_saved, draft) => {
      toast.success("Policy saved");
      // The draft's clusterId is the cluster the dashboard resolved, so this is
      // the same key the form was filled from.
      return queryClient.invalidateQueries({ queryKey: queryKeys.policy(draft.clusterId) });
    },
    // The reason matters, because a save can fail for two different things: the
    // caller is not an owner, or the plan does not include what they switched
    // on. Collapsing both into "owner only" sends half of them looking for a
    // permissions problem they do not have.
    onError: (error) => toast.error(apiMessage(error, "policy not saved")),
  });
}
