// What every recommendation mutation moves: the proposals, the ROI headline and
// the audit trail. Approve, undo or un-hide invalidates this and nothing else.
import type { AuditAction, Recommendation, RoiContribution } from "@repo/contracts";
import { queryOptions } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";

// What the page draws when there is nothing to draw: no cluster yet, or a read
// that failed. Both render as empty panels rather than an error, so one dead
// read cannot blank the two beside it — and the same shape is the useQuery
// default, because useQuery types data as possibly undefined.
export const EMPTY_PIPELINE = {
  recommendations: [] as Recommendation[],
  roi: {
    freedBytes: 0,
    indexesDropped: 0,
    estimatedMonthlyUsd: 0,
    attribution: [] as RoiContribution[],
  },
  activity: [] as AuditAction[],
};

type Pipeline = typeof EMPTY_PIPELINE;

// The cluster is already resolved by the caller — the dashboard's loader picks
// it out of the shell with the same selectCluster the bar uses, so the key is
// always a concrete id (see keys.ts). Null therefore means there is no cluster
// to ask about, not "whichever is first".
async function loadPipeline(clusterId: string | null): Promise<Pipeline> {
  if (clusterId === null) return EMPTY_PIPELINE;
  const client = api();
  try {
    const [recommendations, roi, activity] = await Promise.all([
      client.listRecommendations({ clusterId }),
      client.getRoi({ clusterId }),
      client.listActions({ clusterId }),
    ]);
    return { recommendations, roi, activity };
  } catch {
    return EMPTY_PIPELINE;
  }
}

export function pipelineQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.pipeline(clusterId),
    queryFn: () => loadPipeline(clusterId),
  });
}
