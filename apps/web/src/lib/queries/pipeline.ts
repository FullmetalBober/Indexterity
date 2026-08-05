// The three reads a recommendation mutation moves: the proposals, the ROI
// headline and the audit trail.
//
// One query each. They were one entry behind a Promise.all because approving,
// undoing or un-hiding moves all three at once — but "these go stale together" is
// a fact about invalidation, and it is expressible as three invalidations. What
// the shared entry cost was on the read side: the ROI card could not be drawn
// without also fetching fifty recommendations and the whole trail.
import type { AuditAction, ClusterRoi, Recommendation } from "@repo/contracts";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { queryKeys } from "./keys";

// Stable fallbacks for an absent or failed read — see the note in telemetry.ts.
export const NO_RECOMMENDATIONS: Recommendation[] = [];
export const NO_ACTIVITY: AuditAction[] = [];
// A cluster with nothing dropped yet and a cluster whose ROI read failed both
// show zeroes, which is the honest answer either way: nothing has been proven.
export const NO_ROI: ClusterRoi = {
  clusterId: "",
  freedBytes: 0,
  indexesDropped: 0,
  estimatedMonthlyUsd: 0,
  attribution: [],
};

export function recommendationsQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.recommendations(clusterId),
    queryFn: () =>
      clusterId === null ? NO_RECOMMENDATIONS : api().listRecommendations({ clusterId }),
  });
}

export function roiQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.roi(clusterId),
    queryFn: () => (clusterId === null ? NO_ROI : api().getRoi({ clusterId })),
  });
}

export function activityQuery(clusterId: string | null) {
  return queryOptions({
    queryKey: queryKeys.activity(clusterId),
    queryFn: () => (clusterId === null ? NO_ACTIVITY : api().listActions({ clusterId })),
  });
}

export function useRecommendations(clusterId: string | null): Recommendation[] {
  const { data = NO_RECOMMENDATIONS } = useQuery(recommendationsQuery(clusterId));
  return data;
}

export function useRoi(clusterId: string | null): ClusterRoi {
  const { data = NO_ROI } = useQuery(roiQuery(clusterId));
  return data;
}

export function useActivity(clusterId: string | null): AuditAction[] {
  const { data = NO_ACTIVITY } = useQuery(activityQuery(clusterId));
  return data;
}
