// The engine knobs for one cluster. Already one endpoint, one key — it just
// follows the same shape as the others now: the value is the policy itself rather
// than a `{ policy }` envelope, and a failed read is a query error rather than a
// null smuggled through as data.
import type { ClusterPolicyView } from "@repo/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";
import type { Read } from "./read";

export function policyQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.policy(clusterId),
    queryFn: async () => (clusterId === null ? null : await api().getPolicy({ clusterId })),
  });
}

// Null means no policy section, which is what the dashboard draws when there is
// no cluster or the read failed. The rest of the page renders either way — but a
// null that has not arrived yet is not the same null, and the page draws the
// section's outline for that one instead of nothing. See read.ts.
export function usePolicy(clusterId: string | null): Read<ClusterPolicyView | null> {
  const { data = null, isPending } = useQuery(policyQuery(clusterId));
  return { data, pending: isPending };
}
