// The engine knobs for one cluster. Moves only when someone saves the form,
// which is why it is not part of the pipeline key.
import type { ClusterPolicyView } from "@repo/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";

export const EMPTY_POLICY: { policy: ClusterPolicyView | null } = { policy: null };

async function loadPolicy(clusterId: string | null): Promise<typeof EMPTY_POLICY> {
  if (clusterId === null) return EMPTY_POLICY;
  try {
    return { policy: await api().getPolicy({ clusterId }) };
  } catch {
    // No policy section rather than an error where the form should be. The
    // dashboard renders the rest of the page either way.
    return EMPTY_POLICY;
  }
}

export function policyQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.policy(clusterId),
    queryFn: () => loadPolicy(clusterId),
  });
}
