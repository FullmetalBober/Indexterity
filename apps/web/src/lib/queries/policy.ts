// The engine knobs for one cluster. Already one endpoint, one key — it just
// follows the same shape as the others now: the value is the policy itself rather
// than a `{ policy }` envelope, and a failed read is a query error rather than a
// null smuggled through as data.
import type { ClusterPolicyView } from "@repo/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";

export function policyQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.policy(clusterId),
    queryFn: async () => (clusterId === null ? null : await api().getPolicy({ clusterId })),
  });
}

// Null means no policy section, which is what the dashboard draws when there is
// no cluster or the read failed. The rest of the page renders either way.
export function usePolicy(clusterId: string | null): ClusterPolicyView | null {
  const { data = null } = useQuery(policyQuery(clusterId));
  return data;
}
