// The engine knobs for one cluster. Moves only when someone saves the form,
// which is why it is not part of the pipeline key.
import { queryOptions } from "@tanstack/react-query";
import { loadClusterPolicy } from "../app-server";
import { queryKeys } from "./keys";

export function policyQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.policy(clusterId),
    queryFn: () => loadClusterPolicy({ data: clusterId }),
  });
}

export const EMPTY_POLICY = { policy: null };
