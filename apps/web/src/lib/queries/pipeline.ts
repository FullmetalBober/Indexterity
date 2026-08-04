// What every recommendation mutation moves: the proposals, the ROI headline and
// the audit trail. Approve, undo or un-hide invalidates this and nothing else.
import { queryOptions } from "@tanstack/react-query";
import { loadPipeline } from "../app-server";
import { queryKeys } from "./keys";

export function pipelineQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.pipeline(clusterId),
    queryFn: () => loadPipeline({ data: clusterId }),
  });
}

// Only reached if the cache were empty; the loader fills it and the SSR payload
// carries it across. Kept because useQuery types data as possibly undefined.
export const EMPTY_PIPELINE = {
  recommendations: [],
  roi: { freedBytes: 0, indexesDropped: 0, estimatedMonthlyUsd: 0, attribution: [] },
  activity: [],
};
